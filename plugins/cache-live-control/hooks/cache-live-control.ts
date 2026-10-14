import type { AgentInfo, EngineInterface, On, PluginOptions, Register } from 'claude-code';
import { AGENT_CAP, contextOf, noteRequest, noteSpawn, noteUsage, prune, type AgentRecords } from '../src/agents.ts';
import { formatEvents, pushEvent, type Event } from '../src/events.ts';
import { DEFAULT_FLOOR, guardStatus, guardVerdict, resolveTarget, rewriteTtl, takeOverride, tokenText, type GuardConfig } from '../src/guard.ts';
import { startPlan, type HandoffSnapshot } from '../src/handoff.ts';
import { launchChange } from '../src/launch.ts';
import { forgetsNotice, noticeText, noticeTtl } from '../src/notice.ts';
import { resolveOptions, type ResolvedOptions } from '../src/options.ts';
import { parseArgs, type Settings } from '../src/parse.ts';
import { markFailed, markFired, newRaise, onBoundary, onCommand, onSessionEnd, onWake, raiseStatus, setAfter as setRaiseAfter, type FailureKind, type RaiseState } from '../src/raise.ts';
import { formatState, formatStatus, type EnvSnapshot, type Ours, type Via } from '../src/status.ts';
import { isMarked, summariesStatus, withMark } from '../src/summaries.ts';
import { type Change, type Party, type Ttl } from '../src/ttl.ts';
import { levelRow, pluginLogDir, PluginLogQueue, type PluginLogLevel } from '../src/plugin-log.ts';
import { recordedTtl, warmChanges, warmNote, type Records } from '../src/warmth.ts';

// Thin adapter: every decision lives in src/. Claude Code reads the TTL
// variables on every request, so setting one changes the next request.

const COMMAND = 'cache';
const PLUGIN_VERSION = '0.6.0';

type State = {
  logWork: Promise<void>;
  logFailed: boolean;
  pluginLog?: { queue: PluginLogQueue; source: 'PLUGIN_LOG_DIR' | 'fallback'; session?: string };

  options: ResolvedOptions;
  /** Ignored options, launch-handoff values and a failed start write of the summaries mark, shown by `/cache`. */
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
  /** Every sub-agent's latest request, context, name and parent, for the resume guard. */
  agents: AgentRecords;
  /** The resume guard (option resumeGuard, resumeGuardMinTokens, resumeGuardPrice), live-settable by `/cache guard`. */
  guard: GuardConfig;
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

/** The existing debug door; logger failure never changes a cache decision. */
function pluginLogNotice($: EngineInterface, text: string): void {
  try { $.ui.log(`cache-live-control: ${text}`, { to: 'debug' }); }
  catch { /* The sole fallback door itself is unavailable; do not fail hook work. */ }
}

async function runPluginLog($: EngineInterface, argv: readonly string[]) {
  return $.process.run(argv, { timeoutMs: 5000 });
}

async function queuePluginLog(st: State, $: EngineInterface, level: PluginLogLevel, event: string, msg: string, where: string, detail?: Record<string, unknown>): Promise<void> {
  if (st.pluginLog === undefined) {
    const root = await $.env.get('PLUGIN_LOG_DIR');
    const home = await $.env.get('HOME');
    let session: string | undefined;
    try { session = await $.session.id(); }
    catch (error) { pluginLogNotice($, `plugin log session id unreadable: ${message(error)}`); }
    st.pluginLog = {
      queue: new PluginLogQueue(pluginLogDir(root, home, 'cache-live-control'), 'cache-live-control', (text) => pluginLogNotice($, text)),
      source: root ? 'PLUGIN_LOG_DIR' : 'fallback',
      ...(session === undefined ? {} : { session }),
    };
  }
  let now: number;
  try { now = await $.clock.now(); }
  catch (error) { now = Date.now(); pluginLogNotice($, `plugin log clock unreadable, using wall clock: ${message(error)}`); }
  const log = st.pluginLog;
  if (event === 'logger-ready') detail = { ...detail, dir_source: log.source };
  log.queue.add({ level, row: levelRow({ plugin: 'cache-live-control', level, event, msg, where: `hooks/cache-live-control.ts#${where}`, ...(log.session === undefined ? {} : { session: log.session }), ...(detail === undefined ? {} : { detail }) }, now) });
  st.logFailed = false;
  void log.queue.flush((argv) => runPluginLog($, argv));
}

/** Metadata and writes happen off the hook's path, in order. */
function plog(st: State, $: EngineInterface, level: PluginLogLevel, event: string, msg: string, where: string, detail?: Record<string, unknown>): void {
  st.logWork = st.logWork.then(() => queuePluginLog(st, $, level, event, msg, where, detail)).catch((error: unknown) => {
    if (!st.logFailed) pluginLogNotice($, `plugin log initialization/row failed: ${message(error)}`);
    st.logFailed = true;
  });
}

function fault(st: State, $: EngineInterface, level: PluginLogLevel, event: string, where: string, error: unknown, text: string, debug = false): void {
  $.ui.log(text, debug ? { to: 'debug' } : undefined);
  plog(st, $, level, event, text, where, { error: message(error) });
}

function logReady(st: State, $: EngineInterface): void {
  plog(st, $, 'info', 'logger-ready', 'plugin logger ready', 'session.start', { version: PLUGIN_VERSION });
}

async function flushPluginLog(st: State, $: EngineInterface): Promise<void> {
  await st.logWork;
  await st.pluginLog?.queue.flush((argv) => runPluginLog($, argv));
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

/** The mark in ANTHROPIC_CUSTOM_HEADERS, which Claude Code re-reads for each request: the user's own lines stay. */
async function writeSummaries($: EngineInterface, blocked: boolean): Promise<void> {
  await $.env.set('ANTHROPIC_CUSTOM_HEADERS', withMark(await $.env.get('ANTHROPIC_CUSTOM_HEADERS'), blocked));
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
      fault(st, $, 'error', 'applying-the-starting-ttls-failed', 'startSession', error, `cache-live-control: applying the starting TTLs (launch handoff, mainTtl/subagentTtl options) failed: ${message(error)}`);
    }
    try {
      await consumeHandoff($);
    } catch (error) {
      fault(st, $, 'error', 'unsetting-launch-handoff-failed', 'startSession', error, `cache-live-control: unsetting CACHE_LIVE_CONTROL_MAIN_TTL/CACHE_LIVE_CONTROL_AGENTS_TTL failed: ${message(error)}`);
    }
    try {
      await scopeLaunch1h(st, $, mainChosen);
    } catch (error) {
      fault(st, $, 'error', 'keeping-launch-1h-to-the-main-chat-failed', 'startSession', error, `cache-live-control: keeping ENABLE_PROMPT_CACHING_1H to the main chat failed, sub-agents may run 1h: ${message(error)}`);
    }
    if (st.options.summaries === 'block') {
      try {
        await writeSummaries($, true);
      } catch (error) {
        fault(st, $, 'error', 'marking-requests-to-stop-sub-agent-summaries-failed', 'startSession', error, `cache-live-control: marking requests to stop the sub-agent summaries failed, they may still run: ${message(error)}`);
        st.errors.push(`option summaries block: marking the requests failed, they are not marked: ${message(error)}`);
      }
    }
  }
  try {
    await $.command.register({
      name: COMMAND,
      description: 'Prompt-cache TTL, 5m, 1h or auto, for main, agents or both, and the cache-protection thresholds — words in any order',
      argumentHint: '[main|agents] [5m|1h|auto] [raise N|off] [guard off|warn|block] [summaries on|off]',
      immediate: true,
    });
  } catch (error) {
    fault(st, $, 'error', 'registering-cache-failed', 'startSession', error, `cache-live-control: registering /${COMMAND} failed: ${message(error)}`);
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
    fault(st, $, 'warning', 'weighing-the-wake-for-the-auto-raise-failed', 'weighWake', error, `cache-live-control: weighing the wake for the auto-raise failed: ${message(error)}`, true);
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
    fault(st, $, 'error', 'auto-raise-failed', 'weighWake', error, `cache-live-control: the auto-raise failed, the TTL may be unchanged: ${message(error)}`, true);
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
    fault(st, $, 'error', 'restarting-the-auto-raise-count-failed', 'restartRaise', error, `cache-live-control: restarting the auto-raise count failed: ${message(error)}`, true);
  }
}

/** What the protection did, for `/cache`. */
function note(st: State, at: number, text: string): void {
  st.events = pushEvent(st.events, { at, text });
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
    fault(st, $, 'warning', 'noting-a-request-for-the-resume-guard-failed', 'agentRequest', error, `cache-live-control: noting a request of agent ${id} for the resume guard failed: ${message(error)}`, true);
  }
}

/** A new conversation: its agents are not this one's. */
function endAgents(st: State): void {
  st.conversation += 1;
  st.agents = new Map();
}

/** A started sub-agent: its record gets its name and parent. Never throws. */
async function spawned(st: State, $: EngineInterface, agentId: string, info: { name?: string; parentId?: string }): Promise<void> {
  const conversation = st.conversation;
  try {
    const at = await $.clock.now();
    st.lastAt = at;
    if (st.conversation !== conversation) return;
    st.agents = noteSpawn(st.agents, agentId, { ...info, at });
  } catch (error) {
    fault(st, $, 'warning', 'noting-the-spawn-failed', 'spawned', error, `cache-live-control: noting the spawn of agent ${agentId} failed: ${message(error)}`, true);
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
    const verdict = guardVerdict({
      ...st.guard,
      record,
      label,
      now,
      rewriteTtl: rewriteTtl(await readEnv($), st.ours),
    });
    if (verdict.kind === 'pass') return { body };
    // A running agent gets the message at its next step, which rewrites nothing the message caused.
    listing ??= await $.agent.list();
    if (listing.find((agent) => agent.id === id)?.status === 'running') return { body };
    const size = `(~${tokenText(record.context)} tokens)`;
    if (override !== undefined) {
      note(st, now, `resumed ${label} anyway`);
      plog(st, $, 'warning', 'resumed-anyway', `resumed ${label} anyway`, 'checkSend', { agent: id });
      return { body };
    }
    if (verdict.kind === 'block') {
      note(st, now, `blocked a resume of ${label} ${size}`);
      plog(st, $, 'info', 'resume-blocked', `blocked a resume of ${label} ${size}`, 'checkSend', { agent: id });
      return { deny: verdict.text };
    }
    note(st, now, `warned about a resume of ${label} ${size}`);
    plog(st, $, 'info', 'resume-warned', `warned about a resume of ${label} ${size}`, 'checkSend', { agent: id });
    return { body, warn: verdict.text };
  } catch (error) {
    fault(st, $, 'warning', 'resume-check-failed', 'checkSend', error, `cache-live-control: checking the resume of ${to} failed, the message is sent: ${message(error)}`);
    note(st, st.lastAt ?? Date.now(), `could not check a resume of ${to}: ${message(error)}`);
    return { body };
  }
}

/** The segments `/cache` shows for the protection pieces, the recent events last. */
async function protectionSegments(st: State, $: EngineInterface, env: EnvSnapshot, now: number): Promise<string[]> {
  const events = formatEvents(st.events, now);
  return [
    raiseStatus(st.raise, env, st.ours, now),
    guardStatus(st.guard),
    summariesStatus(isMarked(await $.env.get('ANTHROPIC_CUSTOM_HEADERS'))),
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

  const env = await readEnv($);
  const out: string[] = [];
  if (settings.raise !== undefined) out.push(raiseStatus(st.raise, env, st.ours, now));
  if (settings.guard !== undefined || settings.guardFloor !== undefined || settings.guardPrice !== undefined) out.push(guardStatus(st.guard));
  if (settings.summaries !== undefined) {
    let written = false;
    try {
      await writeSummaries($, settings.summaries === 'off');
      written = true;
      out.push(summariesStatus(isMarked(await $.env.get('ANTHROPIC_CUSTOM_HEADERS'))));
    } catch (error) {
      plog(st, $, written ? 'warning' : 'error', written ? 'summaries-readback-failed' : 'summaries-failed', written ? `reading the summaries header back failed: ${message(error)}` : `summaries failed, the header may be unchanged: ${message(error)}`, 'applySettings', { error: message(error) });
      out.push(
        written
          ? `summaries ${settings.summaries}, reading the header back failed: ${message(error)}`
          : `summaries failed, the header may be unchanged: ${message(error)}`,
      );
    }
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
function toast(st: State, $: EngineInterface, text: string, what: string): void {
  try {
    $.ui.toast(text, { timeoutMs: 10_000 });
  } catch (error) {
    fault(st, $, 'warning', 'showing-toast-failed', 'toast', error, `cache-live-control: showing the ${what} toast failed: ${message(error)}`, true);
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
        if (warm.length > 0 && st.mainTurnRunning) toast(st, $, `${warmNote(warm)} — now ${state}`, 'warm-cache');
        text = warm.length > 0 ? `switched; ${warmNote(warm)}: ${state}` : state;
      } catch (error) {
        text = `failed, the TTL may be unchanged: ${message(error)}`;
        plog(st, $, 'error', 'ttl-change-failed', text, 'runCommand', { error: message(error) });
      }
    }
    // The settings apply whatever became of the TTL words, and say so on their own.
    let set: string[] = [];
    if (action.settings !== undefined) {
      try {
        set = await applySettings(st, $, action.settings, now);
      } catch (error) {
        set = [`settings applied, reading their state failed: ${message(error)}`];
        plog(st, $, 'warning', 'reading-settings-state-failed', set[0]!, 'runCommand', { error: message(error) });
      }
    }
    return { text: [...(text === undefined ? [] : [text]), ...set].join(' · ') };
  } catch (error) {
    plog(st, $, 'error', 'command-failed', `failed, the TTL may be unchanged: ${message(error)}`, 'runCommand', { error: message(error) });
    return { text: `failed, the TTL may be unchanged: ${message(error)}` };
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const resolved = resolveOptions(options as Record<string, unknown>);
  const st: State = {
    logWork: Promise.resolve(),
    logFailed: false,
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
    events: [],
    conversation: 0,
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await startSession(st, $);
    logReady(st, $);
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
      fault(st, $, 'warning', 'noting-a-turn-start-failed', 'turn.start', error, `cache-live-control: noting a turn start failed: ${message(error)}`, true);
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
        fault(st, $, 'warning', 'noting-a-main-request-for-the-warm-cache-warning-failed', 'turn.step', error, `cache-live-control: noting a main request for the warm-cache warning failed: ${message(error)}`, true);
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

  // A new sub-agent's name and parent label it for the resume guard.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e);
    if (result.agentId !== undefined) {
      await spawned(st, $, result.agentId, {
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
    toast(st, $, checked.warn, 'resume-guard');
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
        fault(st, $, 'warning', 'building-the-ttl-notice-failed', 'prompt.submit', error, `cache-live-control: building the TTL notice failed, this prompt goes without it: ${message(error)}`, true);
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
    const result = await next(e);
    await flushPluginLog(st, $);
    return result;
  });
};
