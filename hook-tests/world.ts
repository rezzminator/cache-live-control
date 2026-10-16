import type { AgentInfo, On } from 'claude-code';
import type { Engine } from 'claude-code/testing';

// The world beneath the plugin for the variant hook tests (scripts/test-hook-variants.sh):
// an in-memory environment, a clock that moves only when the test moves it, and
// bottom hooks that record what reached the model's side of each hook.

export const MAIN = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
export const AGENTS = 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL';
export const MIN = 60_000;

export type World = ReturnType<typeof world>;

export function world(on: On, initial: Record<string, string> = {}) {
  const env = new Map(Object.entries(initial));
  // The kit cannot execute host processes. Capture the real append argv;
  // root tests/plugin-log.test.ts drives the adapter with a real execFile.
  const pluginLogRows: { path: string; row: string }[] = [];
  env.set('HOME', initial.HOME ?? '/hook-test/home');
  on('session.id', async () => ({ value: 'variant-session' }));
  on('process.run', async (_$, e) => {
    for (let i = 6; i < e.argv.length; i += 2) pluginLogRows.push({ path: `${e.argv[4]}/${e.argv[i]}`, row: e.argv[i + 1]! });
    return { value: { exitCode: 0, stdout: '', stderr: '' } };
  });
  /** The clock moves only when the test moves it; `fails` makes a read of it throw; `during` runs once inside the next read. */
  let now = 1_000_000_000_000;
  const clock: { fails: boolean; during?: () => Promise<void>; advance: (ms: number) => Promise<void> } = {
    fails: false,
    advance: async (ms: number) => {
      now += ms;
    },
  };
  on('clock.now', async () => {
    if (clock.fails) throw new Error('clock refused');
    const read = now;
    const act = clock.during;
    delete clock.during;
    if (act !== undefined) await act();
    return { value: read } as never;
  });
  /** `reads.fails` makes every env.get throw; `during.set` runs once inside the next env.set, (the test's own engine call). */
  const reads = { fails: false };
  /** Every env.set that reached the bottom, in order. */
  const sets: { name: string; value: string | undefined }[] = [];
  /** The env names whose set is refused. */
  const refused = new Set<string>();
  /** The main variable at each main request, and at each prompt that reached the bottom. */
  const requests: (string | undefined)[] = [];
  const promptsSaw: (string | undefined)[] = [];
  /** The context each prompt carried to the bottom. */
  const contexts: (readonly string[] | undefined)[] = [];
  /** What the plugin logged. */
  const logs: string[] = [];
  /** The agents variable at each sub-agent request, and the usage the next request of an agent reports. */
  const agentRequests: { agentId: string; ttl: string | undefined }[] = [];
  const usageFor = new Map<string, { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }>();
  let turns = 0;
  on('turn.step', async function* (_$, e) {
    if (e.agentId === undefined) requests.push(env.get(MAIN));
    else agentRequests.push({ agentId: e.agentId, ttl: env.get(AGENTS) });
    yield { kind: 'text', index: 0, text: 'hello' } as never;
    const usage = e.agentId === undefined ? null : (usageFor.get(e.agentId) ?? null);
    return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage } as never;
  });
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', async (_$, e) => ({ text: e.answer }));
  /** `prompts.drop` makes the next prompt not enter, as a settings hook's block beneath would. */
  const prompts = { drop: false };
  on('prompt.submit', async (_$, e) => {
    if (prompts.drop) {
      prompts.drop = false;
      return { drop: 'blocked by a settings hook' };
    }
    promptsSaw.push(env.get(MAIN));
    contexts.push(e.context);
    return { text: e.text, context: e.context };
  });
  on('session.compact', async (_$, e) => ({ messages: e.messages }));
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }) as never);
  on('env.get', async (_$, e) => {
    if (reads.fails) throw new Error('env read refused');
    return { value: env.get(e.name) };
  });
  const during: { set?: () => Promise<void> } = {};
  on('env.set', async (_$, e) => {
    if (refused.has(e.name)) throw new Error('env refused');
    sets.push({ name: e.name, value: e.value });
    if (e.value === undefined) env.delete(e.name);
    else env.set(e.name, e.value);
    const act = during.set;
    delete during.set;
    if (act !== undefined) await act();
    return { value: undefined };
  });
  on('command.register', async (_$, e) => ({ value: { command: e.name } }));
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  const toasts: string[] = [];
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text);
    return { value: undefined } as never;
  });
  /** The agents `$.agent.list()` shows; a test edits it. */
  const agentList: AgentInfo[] = [];
  /** `listing.fails` makes every `$.agent.list()` throw. */
  const listing = { fails: false };
  on('agent.list', async () => {
    if (listing.fails) throw new Error('agent list refused');
    return { value: agentList.map((a) => ({ ...a })) } as never;
  });
  /** Each agent.spawn that reached the bottom: the call, the prompt it carried, the id it started. */
  const spawned: { tool_use_id: string; prompt: string; agentId: string; parentAgentId?: string; background: boolean }[] = [];
  on('agent.spawn', async (_$, e) => {
    const agentId = `ag${spawned.length + 1}`;
    spawned.push({ tool_use_id: e.tool_use_id, prompt: e.prompt, agentId, parentAgentId: e.parentAgentId, background: e.background });
    return { model: 'haiku', agentId } as never;
  });
  /** Each tool call that reached the bottom, as it arrived. */
  const calls: Record<string, unknown>[] = [];
  on('tool.call', async (_$, e) => {
    calls.push({ ...(e as unknown as Record<string, unknown>) });
    return { result: 'ok', text: 'ok' } as never;
  });
  on('ui.log', async (_$, e) => {
    logs.push(e.text);
    return { value: undefined } as never;
  });

  /** A main turn a prompt starts, idle: prompt.submit, turn.start, one request, turn.complete. */
  async function typed($: Engine, text = 'go', kind: 'composer' | 'task-notification' | 'scheduled-trigger' = 'composer') {
    await $.prompt.submit({ text, wait: false, origin: { kind } });
    await turn($, text);
  }

  /** A main turn nobody typed (a self-inject): turn.start and one request only. */
  async function turn($: Engine, text = '') {
    turns += 1;
    const turnId = `t${turns}`;
    await $.turn.start({ text, turnId });
    const stream = $.turn.step({ turnId, index: 0, model: 'haiku', messageCount: 1 } as never);
    for (;;) if ((await stream.next()).done) break;
    await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as never);
  }

  let agentTurns = 0;
  /** A sub-agent's request (its turn's first), reporting `context` tokens of usage when given. */
  async function agentStep($: Engine, agentId: string, context?: number) {
    agentTurns += 1;
    const turnId = `at${agentTurns}`;
    if (context !== undefined) {
      usageFor.set(agentId, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: context, model: 'haiku' });
    }
    const stream = $.turn.step({ turnId, index: 0, model: 'haiku', messageCount: 1, agentId } as never);
    for (;;) if ((await stream.next()).done) break;
    return turnId;
  }

  /** A sub-agent's turn ends. */
  async function agentComplete($: Engine, agentId: string) {
    await $.turn.complete({ turnId: `at${agentTurns}`, agentId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as never);
  }

  /** The Agent tool starts a sub-agent: from the main chat, or from `parentAgentId`. Resolves to the id the bottom gave it. */
  let spawnCalls = 0;
  async function spawn($: Engine, over: { name?: string; parentAgentId?: string; background?: boolean; prompt?: string } = {}): Promise<string> {
    spawnCalls += 1;
    const result = await $.agent.spawn({ prompt: 'work', description: 'work', background: false, tool_use_id: `toolu_${spawnCalls}`, ...over } as never);
    return (result as { agentId: string }).agentId;
  }

  /** The model's SendMessage, from the main chat or from `from`. */
  async function send($: Engine, to: string, message: string, from?: string) {
    return $.tool.call({ tool: 'SendMessage', to, message, ...(from === undefined ? {} : { agentId: from }) } as never) as Promise<{ deny?: string; context?: string[] }>;
  }

  /** A Bash call, from the main chat or from `from`. */
  async function bash($: Engine, command: string, background: boolean, from?: string) {
    return $.tool.call({ tool: 'Bash', command, run_in_background: background, ...(from === undefined ? {} : { agentId: from }) } as never);
  }

  return {
    env,
    pluginLogRows,
    clock,
    reads,
    during,
    prompts,
    sets,
    refused,
    requests,
    promptsSaw,
    contexts,
    logs,
    toasts,
    agentList,
    listing,
    spawned,
    calls,
    agentRequests,
    typed,
    turn,
    agentStep,
    agentComplete,
    spawn,
    send,
    bash,
  };
}

export const START = { cwd: '.', surface: null, isInteractive: true } as const;

export function run(args: string) {
  return { command: 'cache', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } };
}

/** `/cache` with no arguments, or with the words given. */
export async function cache($: Engine, args = ''): Promise<string> {
  return (await $.command.run(run(args))).text ?? '';
}

/** One segment of the `/cache` status line, the one starting with `name`. */
export async function segment($: Engine, name: string): Promise<string | undefined> {
  return (await cache($)).split(' · ').find((part) => part.startsWith(name));
}

/** The auto-raise segment of the `/cache` status line. */
export async function raiseLine($: Engine): Promise<string | undefined> {
  return (await cache($)).split(' · ').find((part) => part.startsWith('auto-raise'));
}
