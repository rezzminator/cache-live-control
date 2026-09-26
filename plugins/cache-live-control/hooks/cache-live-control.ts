import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';
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
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readEnv($: EngineInterface): Promise<EnvSnapshot> {
  return {
    main: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    agents: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
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
    await writeParty($, party, value);
    if (value === null) delete st.ours[party];
    else st.ours[party] = { value, via };
  }
}

async function startSession(st: State, $: EngineInterface): Promise<void> {
  if (!st.optionsApplied) {
    st.optionsApplied = true;
    try {
      await apply(st, $, optionChange(st.options, await readEnv($)), 'option');
    } catch (error) {
      $.ui.log(`cache-live-control: applying the mainTtl/subagentTtl options failed: ${message(error)}`);
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
  const st: State = { options: resolveOptions(options as Record<string, unknown>), ours: {}, optionsApplied: false };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await startSession(st, $);
    return result;
  });

  on('command.run', { command: COMMAND }, async ($, e) => runCommand(st, $, e.args));
};
