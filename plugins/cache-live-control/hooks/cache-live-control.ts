import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';
import { launchChange } from '../src/launch.ts';
import { optionChange, resolveOptions, type ResolvedOptions } from '../src/options.ts';
import { parseArgs } from '../src/parse.ts';
import { formatState, formatStatus, type EnvSnapshot, type Ours } from '../src/status.ts';
import type { Change, Party, Ttl } from '../src/ttl.ts';

// Thin adapter: every decision lives in src/. Claude Code reads the TTL
// variables on every request, so setting one changes the next request.

const COMMAND = 'cache';

type State = {
  options: ResolvedOptions;
  ours: Ours;
  /** The options apply once per process, never over a later `/cache`. */
  optionsApplied: boolean;
  /**
   * The launch set ENABLE_PROMPT_CACHING_1H and the plugin moved its 1h to the
   * main chat: `auto` for the main chat returns to that 1h.
   */
  launch1h: boolean;
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

async function apply(st: State, $: EngineInterface, change: Change, via: 'command' | 'option'): Promise<void> {
  for (const party of ['main', 'agents'] as const) {
    const value = change[party];
    if (value === undefined) continue;
    if (value === null && party === 'main' && st.launch1h) {
      await writeParty($, 'main', '1h');
      st.ours.main = { value: '1h', via: 'launch' };
      continue;
    }
    await writeParty($, party, value);
    if (value === null) delete st.ours[party];
    else st.ours[party] = { value, via };
  }
}

/**
 * ENABLE_PROMPT_CACHING_1H at launch: its 1h moves to the main chat's own
 * variable (unless one is set) and the variable is unset, so sub-agents
 * default to 5m.
 */
async function scopeLaunch1h(st: State, $: EngineInterface): Promise<void> {
  const change = launchChange(await readEnv($));
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
    try {
      await apply(st, $, optionChange(st.options, await readEnv($)), 'option');
    } catch (error) {
      $.ui.log(`cache-live-control: applying the mainTtl/subagentTtl options failed: ${message(error)}`);
    }
    try {
      await scopeLaunch1h(st, $);
    } catch (error) {
      $.ui.log(`cache-live-control: keeping ENABLE_PROMPT_CACHING_1H to the main chat failed, sub-agents may run 1h: ${message(error)}`);
    }
  }
  try {
    await $.command.register({
      name: COMMAND,
      description: 'Prompt-cache TTL for this chat: 5m, 1h or auto, for the main chat, sub-agents or both',
      argumentHint: '[5m|1h|auto] | main|agents 5m|1h|auto',
      immediate: true,
    });
  } catch (error) {
    $.ui.log(`cache-live-control: registering /${COMMAND} failed: ${message(error)}`);
  }
}

async function runCommand(st: State, $: EngineInterface, args: string): Promise<{ text: string }> {
  const action = parseArgs(args);
  if (action.kind === 'error') return { text: action.message };
  try {
    if (action.kind === 'status') return { text: formatStatus(await readEnv($), st.ours, st.options.errors) };
    await apply(st, $, action.change, 'command');
    return { text: formatState(await readEnv($), st.ours) };
  } catch (error) {
    return { text: `failed, the TTL may be unchanged: ${message(error)}` };
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const st: State = { options: resolveOptions(options as Record<string, unknown>), ours: {}, optionsApplied: false, launch1h: false };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await startSession(st, $);
    return result;
  });

  on('command.run', { command: COMMAND }, async ($, e) => runCommand(st, $, e.args));
};
