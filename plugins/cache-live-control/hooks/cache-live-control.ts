import type { AgentInfo, EngineInterface, On, PluginOptions, Register } from 'claude-code';
import { defaultDir, handoffFile, handoffStatus, withInstruction } from '../src/agenthandoff.ts';
import { AGENT_CAP, contextOf, noteRequest, noteSpawn, noteUsage, prune, type AgentRecord, type AgentRecords } from '../src/agents.ts';
import { formatEvents, pushEvent, type Event } from '../src/events.ts';
import { DEFAULT_FLOOR, guardStatus, guardVerdict, resolveTarget, rewriteTtl, takeOverride, tokenText, type GuardConfig } from '../src/guard.ts';
import { startPlan, type HandoffSnapshot } from '../src/handoff.ts';
import { launchChange } from '../src/launch.ts';
import { forgetsNotice, noticeText, noticeTtl } from '../src/notice.ts';
import { resolveOptions, type ResolvedOptions } from '../src/options.ts';
import { parseArgs, type Settings } from '../src/parse.ts';
import { markFailed, markFired, newRaise, onBoundary, onCommand, onSessionEnd, onWake, raiseStatus, setAfter as setRaiseAfter, type FailureKind, type RaiseState } from '../src/raise.ts';
import { formatState, formatStatus, type EnvSnapshot, type Ours, type Via } from '../src/status.ts';
import { type Change, type Party, type Ttl } from '../src/ttl.ts';
import { recordedTtl, warmChanges, warmNote, type Records } from '../src/warmth.ts';

// Thin adapter: every decision lives in src/. Claude Code reads the TTL
// variables on every request, so setting one changes the next request.

const COMMAND = 'cache';

type State = {
  options: ResolvedOptions;
  /** Ignored options and handoff values, shown by `/cache`. */
  errors: string[];
  ours: Ours;
  /** Each party's latest model request, for the warm-cache warning. */
  records: Records;
  /** The options apply once per process, never over a later `/cache`. */
  optionsApplied: boolean;
  /**
   * The launch set ENABLE_PROMPT_CACHING_1H and the plugin moved its 1h to the
   * main chat: `auto` for the main chat returns to that 1h.
   */
  launch1h: boolean;
  /**
   * A main-chat turn is running: Claude Code draws a command's reply only once
   * the turn ends, so a warm switch then also shows its warning as a toast.
   */
  mainTurnRunning: boolean;
  /**
   * prompt.submit reached a verdict on the wake that the next turn.start begins,
   * with main's latest request then at `at`: it is final, so the note built on
   * it and the request cannot disagree. A request since, or the prompt not
   * entering, voids it.
   */
  submitted?: { at: number | undefined };
  /** `/cache` commands that changed main: one typed while the raise writes takes precedence over it. */
  mainTyped: number;
  /**
   * The main TTL the TTL notice last told the main chat (option ttlNotice);
   * absent when its context holds none: never told, compacted or cleared.
   */
  noticed?: Ttl;
  /** The auto-raise (option raiseAfterExpiries): its count, lock and whether it fired. */
  raise: RaiseState;
  /** Every sub-agent's latest request, context and spawn, for the resume guard and the handoff. */
  agents: AgentRecords;
  /** The resume guard (option resumeGuard, resumeGuardMinTokens, resumeGuardPrice), live-settable by `/cache guard`. */
  guard: GuardConfig;
  /** The agent handoff (options handoff, handoffDir), live-settable by `/cache handoff`. */
  handoff: { on: boolean; dir?: string };
  /** What the protection did lately, newest last, shown by `/cache`. */
  events: Event[];
  /** The latest time a clock read returned, for an event whose own read failed. */
  lastAt?: number;
  /** Bumped by every new conversation: a request noted across one belongs to the old. */
  conversation: number;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readEnv($: EngineInterface): Promise<EnvSnapshot> {
  return {
    main: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    agents: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
  };
}

async function writeParty($: EngineInterface, party: Party, value: Ttl | null): Promise<void> {
  if (party === 'main') await $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', value ?? undefined);
  else await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', value ?? undefined);
}

async function readHandoff($: EngineInterface): Promise<HandoffSnapshot> {
  return {
    main: await $.env.get('CACHE_LIVE_CONTROL_MAIN_TTL'),
    agents: await $.env.get('CACHE_LIVE_CONTROL_AGENTS_TTL'),
  };
}

/** Consumed: a program the chat starts never inherits them, a reload never re-applies them. */
async function consumeHandoff($: EngineInterface): Promise<void> {
  await $.env.set('CACHE_LIVE_CONTROL_MAIN_TTL', undefined);
  await $.env.set('CACHE_LIVE_CONTROL_AGENTS_TTL', undefined);
}

async function apply(st: State, $: EngineInterface, change: Change, via: Via | Partial<Record<Party, Via>>): Promise<void> {
  for (const party of ['main', 'agents'] as const) {
    const value = change[party];
    if (value === undefined) continue;
    const by = typeof via === 'string' ? via : (via[party] ?? 'command');
    if (value === null && party === 'main' && st.launch1h) {
      await writeParty($, 'main', '1h');
      st.ours.main = { value: '1h', via: 'launch' };
      continue;
    }
    await writeParty($, party, value);
    if (value === null) delete st.ours[party];
    else st.ours[party] = { value, via: by };
  }
}

/**
 * ENABLE_PROMPT_CACHING_1H at launch: its 1h moves to the main chat's own
 * variable (unless one is set) and the variable is unset, so sub-agents
 * default to 5m.
 */
async function scopeLaunch1h(st: State, $: EngineInterface, mainChosen: boolean): Promise<void> {
  const change = launchChange(await readEnv($), mainChosen);
  if (!change.unsetEnable1h) return;
  if (change.main !== undefined) {
    await writeParty($, 'main', change.main);
    st.ours.main = { value: change.main, via: 'launch' };
    st.launch1h = true;
  }
  await $.env.set('ENABLE_PROMPT_CACHING_1H', undefined);
}

async function startSession(st: State, $: EngineInterface): Promise<void> {
  if (!st.optionsApplied) {
    st.optionsApplied = true;
    let mainChosen = false;
    try {
      const plan = startPlan(await readHandoff($), st.options, await readEnv($));
      st.errors.push(...plan.errors);
      mainChosen = plan.via.main === 'handoff';
      await apply(st, $, plan.change, plan.via);
    } catch (error) {
      $.ui.log(`cache-live-control: applying the starting TTLs (launch handoff, mainTtl/subagentTtl options) failed: ${message(error)}`);
    }
    try {
      await consumeHandoff($);
    } catch (error) {
      $.ui.log(`cache-live-control: unsetting CACHE_LIVE_CONTROL_MAIN_TTL/CACHE_LIVE_CONTROL_AGENTS_TTL failed: ${message(error)}`);
    }
    try {
      await scopeLaunch1h(st, $, mainChosen);
    } catch (error) {
      $.ui.log(`cache-live-control: keeping ENABLE_PROMPT_CACHING_1H to the main chat failed, sub-agents may run 1h: ${message(error)}`);
    }
  }
  try {
    await $.command.register({
      name: COMMAND,
      description: 'Prompt-cache TTL, 5m, 1h or auto, for main, agents or both, and the cache-protection thresholds — words in any order',
      argumentHint: '[main|agents] [5m|1h|auto] [raise N|off] [guard off|warn|block] [handoff on|off]',
      immediate: true,
    });
  } catch (error) {
    $.ui.log(`cache-live-control: registering /${COMMAND} failed: ${message(error)}`);
  }
}

/**
 * A main turn is about to send its first request: when it wakes an expired 5m
 * cache for the Nth time, main goes to 1h before that request leaves (option
 * raiseAfterExpiries). One wake counts once, so prompt.submit and turn.start
 * may both ask. A failure is shown by `/cache` and never holds the turn.
 * False when a read failed, so no verdict was reached and turn.start may ask again.
 */
async function weighWake(st: State, $: EngineInterface): Promise<boolean> {
  if (st.raise.after === undefined || st.raise.locked || st.raise.firedAt !== undefined) return true;
  let now: number;
  let weighed: ReturnType<typeof onWake>;
  try {
    now = await $.clock.now();
    const env = await readEnv($);
    // The state is read after the awaits and replaced at once: nothing else runs between.
    weighed = onWake(st.raise, { record: st.records.main, now, env, ours: st.ours });
  } catch (error) {
    st.raise = markFailed(st.raise, message(error), 'read');
    $.ui.log(`cache-live-control: weighing the wake for the auto-raise failed: ${message(error)}`, { to: 'debug' });
    return false;
  }
  st.raise = weighed.state;
  if (!weighed.raise) return true;
  const typed = st.mainTyped;
  try {
    await writeParty($, 'main', '1h');
  } catch (error) {
    // A `/cache main` typed meanwhile has answered since: its word stands.
    if (st.mainTyped === typed) st.raise = markFailed(st.raise, message(error));
    $.ui.log(`cache-live-control: the auto-raise failed, the TTL may be unchanged: ${message(error)}`, { to: 'debug' });
    return true;
  }
  // Only a typed `/cache main` outranks the raise; a restart or a failure landing meanwhile leaves the 1h it wrote its own.
  if (st.mainTyped !== typed) return true;
  st.ours.main = { value: '1h', via: 'raise' };
  st.raise = markFired(st.raise, now);
  return true;
}

/** A compaction or a new session: the requests before it are another prefix, no expiry. */
async function restartRaise(st: State, $: EngineInterface, restart: typeof onBoundary, kind: FailureKind): Promise<void> {
  try {
    // The state is read after the await, so a change made meanwhile stands.
    const now = await $.clock.now();
    st.raise = restart(st.raise, now);
  } catch (error) {
    st.raise = markFailed(st.raise, `restarting the count failed: ${message(error)}`, kind);
    $.ui.log(`cache-live-control: restarting the auto-raise count failed: ${message(error)}`, { to: 'debug' });
  }
}

/** What the protection did, for `/cache`. */
function note(st: State, at: number, text: string): void {
  st.events = pushEvent(st.events, { at, text });
}

/** Where handoff files go: the option, else the plugin's own data directory; undefined when neither is known. */
async function handoffDirOf(st: State, $: EngineInterface): Promise<string | undefined> {
  if (st.handoff.dir !== undefined) return st.handoff.dir;
  return defaultDir({
    root: $.plugin.root,
    name: $.plugin.name,
    configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
    home: await $.env.get('HOME'),
  });
}

/** The file a sub-agent spawned by `spawnId` is asked to write; undefined when the option is off or no directory is known. */
async function handoffPathFor(st: State, $: EngineInterface, spawnId: string | undefined): Promise<string | undefined> {
  if (!st.handoff.on || spawnId === undefined || spawnId === '') return undefined;
  try {
    const dir = await handoffDirOf(st, $);
    return dir === undefined ? undefined : handoffFile(dir, spawnId);
  } catch (error) {
    $.ui.log(`cache-live-control: choosing the handoff directory failed, this agent is not asked for a handoff: ${message(error)}`);
    return undefined;
  }
}

/** The handoff file of a record's agent when the option is on and the file exists. */
async function existingHandoff(st: State, $: EngineInterface, record: AgentRecord): Promise<string | undefined> {
  if (record.spawn === undefined) return undefined;
  const path = await handoffPathFor(st, $, record.spawn);
  if (path === undefined) return undefined;
  try {
    return (await $.fs.exists(path)) ? path : undefined;
  } catch (error) {
    $.ui.log(`cache-live-control: looking for the handoff file ${path} failed, the resume guard names none: ${message(error)}`);
    return undefined;
  }
}

/**
 * A sub-agent's request is about to go out: its record is written with the TTL
 * the request will carry. Never throws.
 */
async function agentRequest(st: State, $: EngineInterface, id: string): Promise<void> {
  const conversation = st.conversation;
  try {
    const at = await $.clock.now();
    st.lastAt = at;
    const ttl = recordedTtl(await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'));
    // A new conversation began meanwhile: this agent is not its.
    if (st.conversation !== conversation) return;
    // The map is read after the awaits above, which let other agents' requests in.
    st.agents = prune(noteRequest(st.agents, id, { at, ttl }), at, st.guard.mode !== 'off', AGENT_CAP);
    st.records.agents = { at, ttl };
  } catch (error) {
    $.ui.log(`cache-live-control: noting a request of agent ${id} for the resume guard failed: ${message(error)}`, { to: 'debug' });
  }
}

/** A new conversation: its agents are not this one's. */
function endAgents(st: State): void {
  st.conversation += 1;
  st.agents = new Map();
}

/** A started sub-agent: its record gets its spawn call, name and parent. Never throws. */
async function spawned(st: State, $: EngineInterface, agentId: string, info: { spawn: string; name?: string; parentId?: string }): Promise<void> {
  const conversation = st.conversation;
  try {
    const at = await $.clock.now();
    st.lastAt = at;
    if (st.conversation !== conversation) return;
    st.agents = noteSpawn(st.agents, agentId, { ...info, at });
  } catch (error) {
    $.ui.log(`cache-live-control: noting the spawn of agent ${agentId} failed: ${message(error)}`, { to: 'debug' });
  }
}

type SendCheck = { deny: string } | { body: string; warn?: string };

/**
 * One SendMessage to `to`: sent as it is, sent with its override marker
 * removed, sent with a warning, or denied. A target that cannot be checked is
 * sent to, and `/cache` says so.
 */
async function checkSend(st: State, $: EngineInterface, to: string, text: string): Promise<SendCheck> {
  // The marker goes whatever the guard says, off included: a block may have taught it before the guard went off.
  const override = takeOverride(text);
  const body = override ?? text;
  if (st.guard.mode === 'off') return { body };
  try {
    const now = await $.clock.now();
    st.lastAt = now;
    let listing: readonly AgentInfo[] | undefined = resolveTarget(to, st.agents, []) === undefined ? await $.agent.list() : undefined;
    const id = resolveTarget(to, st.agents, listing ?? []);
    const record = id === undefined ? undefined : st.agents.get(id);
    if (id === undefined || record === undefined) return { body };
    const label = record.name ?? (to === id ? id : to);
    const handoff = await existingHandoff(st, $, record);
    const verdict = guardVerdict({
      ...st.guard,
      record,
      label,
      now,
      rewriteTtl: rewriteTtl(await readEnv($), st.ours),
      ...(handoff === undefined ? {} : { handoff }),
    });
    if (verdict.kind === 'pass') return { body };
    // A running agent gets the message at its next step, which rewrites nothing the message caused.
    listing ??= await $.agent.list();
    if (listing.find((agent) => agent.id === id)?.status === 'running') return { body };
    const size = `(~${tokenText(record.context)} tokens)`;
    if (override !== undefined) {
      note(st, now, `resumed ${label} anyway`);
      return { body };
    }
    if (verdict.kind === 'block') {
      note(st, now, `blocked a resume of ${label} ${size}`);
      return { deny: verdict.text };
    }
    note(st, now, `warned about a resume of ${label} ${size}`);
    return { body, warn: verdict.text };
  } catch (error) {
    $.ui.log(`cache-live-control: checking the resume of ${to} failed, the message is sent: ${message(error)}`);
    note(st, st.lastAt ?? Date.now(), `could not check a resume of ${to}: ${message(error)}`);
    return { body };
  }
}

/** The segments `/cache` shows for the protection pieces, the recent events last. */
async function protectionSegments(st: State, $: EngineInterface, env: EnvSnapshot, now: number): Promise<string[]> {
  const dir = st.handoff.on ? await handoffDirOf(st, $) : undefined;
  const events = formatEvents(st.events, now);
  return [
    raiseStatus(st.raise, env, st.ours, now),
    guardStatus(st.guard),
    handoffStatus({ handoff: st.handoff.on, ...(dir === undefined ? {} : { dir }) }),
    ...(events === undefined ? [] : [events]),
  ];
}

/** The thresholds a `/cache` command sets live; the segments of the pieces it touched, for its reply. */
async function applySettings(st: State, $: EngineInterface, settings: Settings, now: number): Promise<string[]> {
  if (settings.raise !== undefined) st.raise = setRaiseAfter(st.raise, settings.raise ?? undefined);
  if (settings.guard !== undefined) st.guard = { ...st.guard, mode: settings.guard };
  if (settings.guardFloor !== undefined) st.guard = { ...st.guard, floor: settings.guardFloor };
  if (settings.guardPrice !== undefined) {
    const { price: _price, ...rest } = st.guard;
    st.guard = settings.guardPrice === null ? rest : { ...rest, price: settings.guardPrice };
  }
  if (settings.handoff !== undefined) st.handoff = { ...st.handoff, on: settings.handoff };

  const env = await readEnv($);
  const out: string[] = [];
  if (settings.raise !== undefined) out.push(raiseStatus(st.raise, env, st.ours, now));
  if (settings.guard !== undefined || settings.guardFloor !== undefined || settings.guardPrice !== undefined) out.push(guardStatus(st.guard));
  if (settings.handoff !== undefined) {
    const dir = st.handoff.on ? await handoffDirOf(st, $) : undefined;
    out.push(handoffStatus({ handoff: st.handoff.on, ...(dir === undefined ? {} : { dir }) }));
  }
  return out;
}

/** A model request is about to go out: note when, and the TTL its party's variable holds. */
async function recordStep(st: State, $: EngineInterface, party: Party): Promise<void> {
  const at = await $.clock.now();
  const variable = party === 'main' ? await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL') : await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL');
  st.records[party] = { at, ttl: recordedTtl(variable) };
}

/** A warning shown at once; a failure is logged and never changes the reply. */
function toast($: EngineInterface, text: string, what: string): void {
  try {
    $.ui.toast(text, { timeoutMs: 10_000 });
  } catch (error) {
    $.ui.log(`cache-live-control: showing the ${what} toast failed: ${message(error)}`, { to: 'debug' });
  }
}

async function runCommand(st: State, $: EngineInterface, args: string): Promise<{ text: string }> {
  const action = parseArgs(args);
  if (action.kind === 'error') return { text: action.message };
  try {
    const now = await $.clock.now();
    st.lastAt = now;
    if (action.kind === 'status') {
      const env = await readEnv($);
      const errors = [...st.options.errors, ...st.errors];
      return { text: formatStatus(env, st.ours, errors, { records: st.records, now }, await protectionSegments(st, $, env, now)) };
    }
    const changes = Object.keys(action.change).length > 0;
    let text: string | undefined;
    if (changes) {
      try {
        const warm = warmChanges(action.change, await readEnv($), st.records, now, st.launch1h);
        try {
          await apply(st, $, action.change, 'command');
        } finally {
          // The user's explicit word wins, whether or not every write landed.
          st.raise = onCommand(st.raise, action.change);
          if (action.change.main !== undefined) st.mainTyped += 1;
        }
        const state = formatState(await readEnv($), st.ours);
        if (warm.length > 0 && st.mainTurnRunning) toast($, `${warmNote(warm)} — now ${state}`, 'warm-cache');
        text = warm.length > 0 ? `switched; ${warmNote(warm)}: ${state}` : state;
      } catch (error) {
        text = `failed, the TTL may be unchanged: ${message(error)}`;
      }
    }
    // The settings apply whatever became of the TTL words, and say so on their own.
    let set: string[] = [];
    if (action.settings !== undefined) {
      try {
        set = await applySettings(st, $, action.settings, now);
      } catch (error) {
        set = [`settings applied, reading their state failed: ${message(error)}`];
      }
    }
    return { text: [...(text === undefined ? [] : [text]), ...set].join(' · ') };
  } catch (error) {
    return { text: `failed, the TTL may be unchanged: ${message(error)}` };
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const resolved = resolveOptions(options as Record<string, unknown>);
  const st: State = {
    options: resolved,
    raise: newRaise(resolved.raiseAfter),
    errors: [],
    ours: {},
    records: {},
    optionsApplied: false,
    launch1h: false,
    mainTurnRunning: false,
    mainTyped: 0,
    agents: new Map(),
    guard: {
      mode: resolved.guard ?? 'off',
      floor: resolved.guardFloor ?? DEFAULT_FLOOR,
      ...(resolved.guardPrice === undefined ? {} : { price: resolved.guardPrice }),
    },
    handoff: { on: resolved.handoff === true, ...(resolved.handoffDir === undefined ? {} : { dir: resolved.handoffDir }) },
    events: [],
    conversation: 0,
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await startSession(st, $);
    return result;
  });

  // Whether a main-chat turn is running, for the warm-cache toast, and the
  // auto-raise's second look at the wake: a turn no prompt.submit hook saw (a
  // plugin's own self-inject) still goes out at the raised TTL, because the
  // variable is set before `next` and so before the turn's first request.
  // turn.start carries no agentId today; it is read in case a sub-agent's turn
  // ever carries one. turn.complete fires for aborted turns too.
  on('turn.start', async ($, e, next) => {
    try {
      if ((e as { agentId?: string }).agentId === undefined) {
        st.mainTurnRunning = true;
        const submitted = st.submitted;
        delete st.submitted;
        if (submitted === undefined || submitted.at !== st.records.main?.at) await weighWake(st, $);
      }
    } catch (error) {
      $.ui.log(`cache-live-control: noting a turn start failed: ${message(error)}`, { to: 'debug' });
    }
    return next(e);
  });

  on('turn.complete', async (_$, e, next) => {
    if (e.agentId === undefined) st.mainTurnRunning = false;
    return next(e);
  });

  // A request is noted without holding it, and the stream itself passes through
  // untouched; a sub-agent's usage waits for its record.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      recordStep(st, $, 'main').catch((error: unknown) => {
        $.ui.log(`cache-live-control: noting a main request for the warm-cache warning failed: ${message(error)}`, { to: 'debug' });
      });
      return yield* next(e);
    }
    const noted = agentRequest(st, $, e.agentId);
    const result = yield* next(e);
    await noted;
    const context = contextOf(result.usage);
    if (context !== undefined) st.agents = noteUsage(st.agents, e.agentId, context);
    return result;
  });

  // With the handoff option, a new sub-agent is asked to write a handoff file named
  // by this call (its own id is known only after the spawn returns).
  on('agent.spawn', async ($, e, next) => {
    const path = await handoffPathFor(st, $, e.tool_use_id);
    const result = await next(path === undefined ? e : { ...e, prompt: withInstruction(e.prompt, path) });
    if (result.agentId !== undefined) {
      await spawned(st, $, result.agentId, {
        spawn: e.tool_use_id,
        ...(e.name === undefined ? {} : { name: e.name }),
        ...(e.parentAgentId === undefined ? {} : { parentId: e.parentAgentId }),
      });
    }
    return result;
  });

  // The resume guard: a SendMessage to a cold, large sub-agent.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const call = e as unknown as { to?: unknown; message?: unknown };
    if (typeof call.to !== 'string' || typeof call.message !== 'string') return next(e);
    const checked = await checkSend(st, $, call.to, call.message);
    if ('deny' in checked) return { deny: checked.deny };
    const result = await next(checked.body === call.message ? e : ({ ...e, message: checked.body } as typeof e));
    if (checked.warn === undefined || result.deny !== undefined) return result;
    toast($, checked.warn, 'resume-guard');
    return { ...result, context: [...(result.context ?? []), checked.warn] };
  });

  on('command.run', { command: COMMAND }, async ($, e) => runCommand(st, $, e.args));

  // A prompt that wakes an idle session (any origin: typed, a background
  // task's return, a scheduled trigger) is weighed for the auto-raise first, so
  // the variable is final before the note below names it and before the
  // request leaves. A prompt typed or delivered into a running turn
  // (e.turnId set) starts no turn and is no wake.
  // Option ttlNotice: a prompt carries the note when the main TTL differs from
  // the one last told. prompt.submit is the main chat's alone: a sub-agent's
  // prompt goes through agent.spawn, and the input carries no agentId.
  on('prompt.submit', async ($, e, next) => {
    let stamp: State['submitted'];
    if (e.turnId === undefined && (await weighWake(st, $))) {
      stamp = { at: st.records.main?.at };
      st.submitted = stamp;
    }
    let n: Ttl | null = null;
    if (st.options.notice === true) {
      try {
        n = noticeTtl(await readEnv($), st.ours);
      } catch (error) {
        $.ui.log(`cache-live-control: building the TTL notice failed, this prompt goes without it: ${message(error)}`, { to: 'debug' });
      }
    }
    if (n === st.noticed) n = null;
    const result = await next(n === null ? e : { ...e, context: [...(e.context ?? []), noticeText(n)] });
    if (result.drop === undefined) {
      if (n !== null) st.noticed = n;
    } else if (stamp !== undefined && st.submitted === stamp) {
      // The prompt did not enter, so it starts no turn: its verdict spares none.
      delete st.submitted;
    }
    return result;
  });

  // A main-chat compaction takes the note out: the next prompt carries it
  // again. It also rewrites the prefix: the wake after it is no expiry.
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (forgetsNotice(e, result)) {
      delete st.noticed;
      // A precompute installs nothing: the prefix, and its expiry, stand.
      if (e.trigger !== 'precompute') await restartRaise(st, $, onBoundary, 'compact');
    }
    return result;
  });

  // A /clear or a resume ends the conversation here (no session.start fires for
  // the one that follows): the next one has not read the note, and the
  // auto-raise counts its session over.
  on('session.end', async ($, e, next) => {
    delete st.noticed;
    await restartRaise(st, $, onSessionEnd, 'end');
    endAgents(st);
    return next(e);
  });
};
