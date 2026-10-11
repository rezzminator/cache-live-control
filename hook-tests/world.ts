import type { On } from 'claude-code';
import { mock, type Engine } from 'claude-code/testing';

// The world beneath the plugin for the variant hook tests (scripts/test-hook-variants.sh):
// an in-memory environment, a clock that moves only when the test moves it, and
// bottom hooks that record what reached the model's side of each hook.

export const MAIN = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
export const AGENTS = 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL';
export const MIN = 60_000;

export type World = ReturnType<typeof world>;

export function world(on: On, initial: Record<string, string> = {}) {
  const env = new Map(Object.entries(initial));
  const clock = mock.clock(on, { now: 1_000_000_000_000 });
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
  let turns = 0;
  on('turn.step', async function* (_$, e) {
    if (e.agentId === undefined) requests.push(env.get(MAIN));
    yield { kind: 'text', index: 0, text: 'hello' } as never;
    return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage: null } as never;
  });
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', async (_$, e) => ({ text: e.answer }));
  on('prompt.submit', async (_$, e) => {
    promptsSaw.push(env.get(MAIN));
    contexts.push(e.context);
    return { text: e.text, context: e.context };
  });
  on('session.compact', async (_$, e) => ({ messages: e.messages }));
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }) as never);
  on('env.get', async (_$, e) => ({ value: env.get(e.name) }));
  on('env.set', async (_$, e) => {
    if (refused.has(e.name)) throw new Error('env refused');
    sets.push({ name: e.name, value: e.value });
    if (e.value === undefined) env.delete(e.name);
    else env.set(e.name, e.value);
    return { value: undefined };
  });
  on('command.register', async (_$, e) => ({ value: { command: e.name } }));
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  on('ui.toast', async () => ({ value: undefined }) as never);
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

  return { env, clock, sets, refused, requests, promptsSaw, contexts, logs, typed, turn };
}

export const START = { cwd: '.', surface: null, isInteractive: true } as const;

export function run(args: string) {
  return { command: 'cache', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } };
}

/** `/cache` with no arguments, or with the words given. */
export async function cache($: Engine, args = ''): Promise<string> {
  return (await $.command.run(run(args))).text ?? '';
}

/** The auto-raise segment of the `/cache` status line. */
export async function raiseLine($: Engine): Promise<string | undefined> {
  return (await cache($)).split(' · ').find((part) => part.startsWith('auto-raise'));
}
