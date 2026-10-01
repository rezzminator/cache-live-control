import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';
import { startPlan, type HandoffSnapshot } from '../src/handoff.ts';
import { launchChange } from '../src/launch.ts';
import { forgetsNotice, noticeText, noticeTtl, type Notice } from '../src/notice.ts';
import { resolveOptions, type ResolvedOptions } from '../src/options.ts';
import { parseArgs } from '../src/parse.ts';
import { formatState, formatStatus, type EnvSnapshot, type Ours, type Via } from '../src/status.ts';
import type { Change, Party, Ttl } from '../src/ttl.ts';
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
   * The main TTL the TTL notice last told the main chat (option ttlNotice);
   * absent when its context holds none: never told, compacted or cleared.
   */
  noticed?: Ttl;
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
      description: 'Prompt-cache TTL, 5m, 1h or auto, for main, agents or both — words in any order',
      argumentHint: '[main|agents] [5m|1h|auto]',
      immediate: true,
    });
  } catch (error) {
    $.ui.log(`cache-live-control: registering /${COMMAND} failed: ${message(error)}`);
  }
}

/** A model request is about to go out: note when, and the TTL its party's variable holds. */
async function recordStep(st: State, $: EngineInterface, party: Party, at: number): Promise<void> {
  const variable = party === 'main' ? await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL') : await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL');
  st.records[party] = { at, ttl: recordedTtl(variable) };
}

/** The warning at once while a main turn runs; a failure is logged and never changes the reply. */
function toastWarm($: EngineInterface, text: string): void {
  try {
    $.ui.toast(text, { timeoutMs: 10_000 });
  } catch (error) {
    $.ui.log(`cache-live-control: showing the warm-cache toast failed: ${message(error)}`, { to: 'debug' });
  }
}

async function runCommand(st: State, $: EngineInterface, args: string): Promise<{ text: string }> {
  const action = parseArgs(args);
  if (action.kind === 'error') return { text: action.message };
  try {
    if (action.kind === 'status') {
      return { text: formatStatus(await readEnv($), st.ours, [...st.options.errors, ...st.errors], { records: st.records, now: Date.now() }) };
    }
    const warm = warmChanges(action.change, await readEnv($), st.records, Date.now(), st.launch1h);
    await apply(st, $, action.change, 'command');
    const state = formatState(await readEnv($), st.ours);
    if (warm.length > 0 && st.mainTurnRunning) toastWarm($, `${warmNote(warm)} — now ${state}`);
    return { text: warm.length > 0 ? `switched; ${warmNote(warm)}: ${state}` : state };
  } catch (error) {
    return { text: `failed, the TTL may be unchanged: ${message(error)}` };
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const st: State = {
    options: resolveOptions(options as Record<string, unknown>),
    errors: [],
    ours: {},
    records: {},
    optionsApplied: false,
    launch1h: false,
    mainTurnRunning: false,
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await startSession(st, $);
    return result;
  });

  // Observe only: whether a main-chat turn is running, for the warm-cache toast.
  // turn.start carries no agentId today; it is read in case a sub-agent's turn
  // ever carries one. turn.complete fires for aborted turns too.
  on('turn.start', async ($, e, next) => {
    try {
      if ((e as { agentId?: string }).agentId === undefined) st.mainTurnRunning = true;
    } catch (error) {
      $.ui.log(`cache-live-control: noting a turn start failed: ${message(error)}`, { to: 'debug' });
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    try {
      if (e.agentId === undefined) st.mainTurnRunning = false;
    } catch (error) {
      $.ui.log(`cache-live-control: noting a turn end failed: ${message(error)}`, { to: 'debug' });
    }
    return next(e);
  });

  // Observes only: the stream passes through untouched and is never held.
  on('turn.step', async function* ($, e, next) {
    const party: Party = e.agentId === undefined ? 'main' : 'agents';
    recordStep(st, $, party, Date.now()).catch((error: unknown) => {
      $.ui.log(`cache-live-control: noting a ${party} request for the warm-cache warning failed: ${message(error)}`, { to: 'debug' });
    });
    return yield* next(e);
  });

  on('command.run', { command: COMMAND }, async ($, e) => runCommand(st, $, e.args));

  // Option ttlNotice: a prompt carries the note when the main TTL differs from
  // the one last told. prompt.submit is the main chat's alone: a sub-agent's
  // prompt goes through agent.spawn, and the input carries no agentId.
  on('prompt.submit', async ($, e, next) => {
    if (st.options.notice !== true) return next(e);
    let n: Notice | null;
    try {
      n = noticeTtl(await readEnv($), st.ours);
    } catch (error) {
      $.ui.log(`cache-live-control: building the TTL notice failed, this prompt goes without it: ${message(error)}`, { to: 'debug' });
      return next(e);
    }
    if (n === null || n.ttl === st.noticed) return next(e);
    const result = await next({ ...e, context: [...(e.context ?? []), noticeText(n)] });
    if (result.drop === undefined) st.noticed = n.ttl;
    return result;
  });

  // A main-chat compaction takes the note out: the next prompt carries it again.
  on('session.compact', async (_$, e, next) => {
    const result = await next(e);
    if (forgetsNotice(e, result)) delete st.noticed;
    return result;
  });

  // A /clear or a resume ends the conversation here (no session.start fires for
  // the one that follows): the next one has not read the note.
  on('session.end', async (_$, e, next) => {
    delete st.noticed;
    return next(e);
  });
};
