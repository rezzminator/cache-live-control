import type { On } from 'claude-code';
import { describe, expect, test, type Engine } from 'claude-code/testing';

// Run with `claude plugin test plugins/cache-live-control`: the plugin loads
// from this folder under the engine's own host; `on` here sits beneath it and
// answers `$.env` and `$.command.register` from memory.

const MAIN = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
const AGENTS = 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL';
const ENABLE_1H = 'ENABLE_PROMPT_CACHING_1H';
const AGENTS_AUTO = "5m, unless subagentPromptCacheTtl or the agent's frontmatter sets it";

const HANDOFF_MAIN = 'CACHE_LIVE_CONTROL_MAIN_TTL';
const HANDOFF_AGENTS = 'CACHE_LIVE_CONTROL_AGENTS_TTL';

/** `answer`: what the AskUserQuestion dialog answers, or an Error it throws; each question asked is kept. */
function world(on: On, initial: Record<string, string> = {}, answer: string | Error = 'Switch now') {
  const env = new Map(Object.entries(initial));
  const commands: string[] = [];
  const asked: string[] = [];
  on('tool.call', async (_$, e) => {
    if (e.tool !== 'AskUserQuestion') return { deny: 'not in this test' };
    const question = String((e as { questions?: { question?: string }[] }).questions?.[0]?.question);
    asked.push(question);
    if (answer instanceof Error) throw answer;
    return { result: { questions: [], answers: { [question]: answer } } };
  });
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'hello' } as never;
    return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage: null } as never;
  });
  on('env.get', async (_$, e) => ({ value: env.get(e.name) }));
  on('env.set', async (_$, e) => {
    if (e.value === undefined) env.delete(e.name);
    else env.set(e.name, e.value);
    return { value: undefined };
  });
  on('command.register', async (_$, e) => {
    commands.push(e.name);
    return { value: { command: e.name } };
  });
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  return { env, commands, asked };
}

/** One model request of a party, read to its end: the chunks and result the plugin let through. */
async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) } as never);
  const chunks: unknown[] = [];
  for (;;) {
    const r = await stream.next();
    if (r.done) return { chunks, result: r.value };
    chunks.push(r.value);
  }
}

const START = { cwd: '.', surface: null, isInteractive: true } as const;

function run(args: string) {
  return { command: 'cache', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } };
}

describe('/cache', () => {
  test('is registered at session start, immediate', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(w.commands).toContain('cache');
  });

  test('5m sets both variables', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const out = await $.command.run(run('5m'));
    expect(w.env.get(MAIN)).toBe('5m');
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(out.text).toBe('main 5m · agents 5m');
  });

  test('main auto unsets only the main variable', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await $.command.run(run('1h'));
    const out = await $.command.run(run('main auto'));
    expect(w.env.has(MAIN)).toBe(false);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(out.text).toBe('main automatic · agents 1h');
  });

  test('status names each source and warns on FORCE_PROMPT_CACHING_5M', async ($, on) => {
    world(on, { [AGENTS]: '1h', FORCE_PROMPT_CACHING_5M: '1' });
    await $.session.start(START);
    await $.command.run(run('main 5m'));
    const out = await $.command.run(run(''));
    expect(out.text).toBe(
      'main 5m (set by /cache, cold) · agents 1h (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL set outside this plugin, cold) · warning: FORCE_PROMPT_CACHING_5M="1" is set, so every request uses 5m',
    );
  });

  test('takes its words in any order', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect((await $.command.run(run('1h agents, 5m main'))).text).toBe('main 5m · agents 1h');
    expect(w.env.get(MAIN)).toBe('5m');
    expect(w.env.get(AGENTS)).toBe('1h');
  });

  test('a bad argument changes nothing', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    const out = await $.command.run(run('main 30m'));
    expect(w.env.get(MAIN)).toBe('1h');
    expect(w.env.has(AGENTS)).toBe(false);
    expect(out.text).toMatch(/^nothing changed: "30m" is not 5m, 1h, auto, main, agents or force; usage: /);
  });
});

describe('options', () => {
  // The kit loads the plugin under test with its manifest's defaults and has no
  // way to hand it other options (an inline plugin is re-emitted as a module of
  // its own and cannot import this one). A non-empty mainTtl/subagentTtl is
  // covered by tests/options.test.ts and by scripts/live-proof.sh.
  test('the default options leave both variables alone at session start', async ($, on) => {
    const w = world(on, { [AGENTS]: '1h' });
    await $.session.start(START);
    expect(w.env.has(MAIN)).toBe(false);
    expect(w.env.get(AGENTS)).toBe('1h');
    const out = await $.command.run(run(''));
    expect(out.text).toBe(
      'main automatic (settings, agent frontmatter or plan default, cold) · agents 1h (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL set outside this plugin, cold)',
    );
  });
});

describe('ENABLE_PROMPT_CACHING_1H at launch', () => {
  // Claude Code reads it for the main chat AND every sub-agent; the plugin
  // keeps its 1h for the main chat only, so sub-agents default to 5m.
  test('keeps 1h for the main chat only; the sub-agents fall back to 5m', async ($, on) => {
    const w = world(on, { [ENABLE_1H]: '1' });
    await $.session.start(START);
    expect(w.env.has(ENABLE_1H)).toBe(false);
    expect(w.env.get(MAIN)).toBe('1h');
    expect(w.env.has(AGENTS)).toBe(false);
    const out = await $.command.run(run(''));
    expect(out.text).toBe(`main 1h (ENABLE_PROMPT_CACHING_1H at launch, main chat only, cold) · agents automatic (${AGENTS_AUTO}, cold)`);
  });

  test('a main variable set at launch wins; the sub-agents still lose the 1h', async ($, on) => {
    const w = world(on, { [ENABLE_1H]: '1', [MAIN]: '5m' });
    await $.session.start(START);
    expect(w.env.has(ENABLE_1H)).toBe(false);
    expect(w.env.get(MAIN)).toBe('5m');
    expect(w.env.has(AGENTS)).toBe(false);
  });

  test('main auto and auto return the main chat to the launch 1h', async ($, on) => {
    const w = world(on, { [ENABLE_1H]: '1' });
    await $.session.start(START);
    await $.command.run(run('5m'));
    expect(w.env.get(MAIN)).toBe('5m');
    expect((await $.command.run(run('main auto'))).text).toBe('main 1h · agents 5m');
    expect(w.env.get(MAIN)).toBe('1h');
    expect((await $.command.run(run('auto'))).text).toBe('main 1h · agents automatic');
    expect(w.env.has(AGENTS)).toBe(false);
    expect(w.env.has(ENABLE_1H)).toBe(false);
  });

  test('/cache agents 1h still raises the sub-agents', async ($, on) => {
    const w = world(on, { [ENABLE_1H]: '1' });
    await $.session.start(START);
    expect((await $.command.run(run('agents 1h'))).text).toBe('main 1h · agents 1h');
    expect(w.env.get(AGENTS)).toBe('1h');
  });

  test('an off value is left alone', async ($, on) => {
    const w = world(on, { [ENABLE_1H]: '0' });
    await $.session.start(START);
    expect(w.env.get(ENABLE_1H)).toBe('0');
    expect(w.env.has(MAIN)).toBe(false);
  });
});


describe('launch handoff', () => {
  test('applies the handoff variables at start, credits them, and unsets them', async ($, on) => {
    const w = world(on, { [HANDOFF_MAIN]: '1h', [HANDOFF_AGENTS]: '5m' });
    await $.session.start(START);
    expect(w.env.get(MAIN)).toBe('1h');
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(w.env.has(HANDOFF_MAIN)).toBe(false);
    expect(w.env.has(HANDOFF_AGENTS)).toBe(false);
    expect((await $.command.run(run(''))).text).toBe('main 1h (set at launch, cold) · agents 5m (set at launch, cold)');
  });

  test('a variable set at launch beats the handoff; a bad handoff is named by /cache', async ($, on) => {
    const w = world(on, { [MAIN]: '5m', [HANDOFF_MAIN]: '1h', [HANDOFF_AGENTS]: '2h' });
    await $.session.start(START);
    expect(w.env.get(MAIN)).toBe('5m');
    expect(w.env.has(AGENTS)).toBe(false);
    expect(w.env.has(HANDOFF_MAIN)).toBe(false);
    expect((await $.command.run(run(''))).text).toMatch(/ · CACHE_LIVE_CONTROL_AGENTS_TTL "2h" ignored: use 5m, 1h or auto$/);
  });

  test('a handoff auto keeps ENABLE_PROMPT_CACHING_1H off the main chat too', async ($, on) => {
    const w = world(on, { [ENABLE_1H]: '1', [HANDOFF_MAIN]: 'auto' });
    await $.session.start(START);
    expect(w.env.has(MAIN)).toBe(false);
    expect(w.env.has(ENABLE_1H)).toBe(false);
  });
});

describe('warm-cache check', () => {
  test('turn.step passes the stream through unchanged and records the request', async ($, on) => {
    world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    const r = await step($);
    expect(r.chunks).toEqual([{ kind: 'text', index: 0, text: 'hello' }]);
    expect(r.result).toEqual({ turnId: 't', index: 0, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage: null });
    expect((await $.command.run(run(''))).text).toMatch(/^main 1h \(CLAUDE_CODE_PROMPT_CACHE_TTL set outside this plugin, warm 60m\) · agents automatic \(.*, cold\)$/);
  });

  test('a warm change asks; Switch now applies', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    await step($);
    const out = await $.command.run(run('main 5m'));
    expect(w.asked).toEqual([
      "main's prompt cache is warm for 60 more minutes (1h, last request under a minute ago); switching it to 5m may rewrite the whole cache on the next request. Switch anyway?",
    ]);
    expect(w.env.get(MAIN)).toBe('5m');
    expect(out.text).toBe('switched; the next request may rewrite the cache: main 5m · agents automatic');
  });

  test('Keep the warm cache changes nothing', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' }, 'Keep the warm cache');
    await $.session.start(START);
    await step($);
    const out = await $.command.run(run('5m main'));
    expect(w.env.get(MAIN)).toBe('1h');
    expect(out.text).toBe("nothing changed: main's cache is warm for 60 more minutes; /cache 5m main force switches anyway");
  });

  test('a dialog that throws changes nothing', async ($, on) => {
    const w = world(on, { [AGENTS]: '5m' }, new Error('no dialog'));
    await $.session.start(START);
    await step($, 'agent-1');
    const out = await $.command.run(run('agents 1h'));
    expect(w.asked).toHaveLength(1);
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(out.text).toBe("nothing changed: agents' cache is warm for 5 more minutes; /cache agents 1h force switches anyway");
  });

  test('force skips the ask', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' }, 'Keep the warm cache');
    await $.session.start(START);
    await step($);
    const out = await $.command.run(run('main 5m force'));
    expect(w.asked).toEqual([]);
    expect(w.env.get(MAIN)).toBe('5m');
    expect(out.text).toBe('main 5m · agents automatic');
  });

  test('a cold party, or a warm one kept at its TTL, changes at once', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' }, 'Keep the warm cache');
    await $.session.start(START);
    await step($);
    expect((await $.command.run(run('agents 1h'))).text).toBe('main 1h · agents 1h');
    expect((await $.command.run(run('main 1h'))).text).toBe('main 1h · agents 1h');
    expect(w.asked).toEqual([]);
    expect(w.env.get(AGENTS)).toBe('1h');
  });
});
