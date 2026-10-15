import type { On } from 'claude-code';
import { describe, expect, mock, test, type Engine } from 'claude-code/testing';

// Run with `claude plugin test plugins/cache-live-control`: the plugin loads
// from this folder under the engine's own host; `on` here sits beneath it and
// answers `$.env` and `$.command.register` from memory.

const MAIN = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
const AGENTS = 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL';
const ENABLE_1H = 'ENABLE_PROMPT_CACHING_1H';
const AGENTS_AUTO = "5m, unless subagentPromptCacheTtl or the agent's frontmatter sets it";

const HANDOFF_MAIN = 'CACHE_LIVE_CONTROL_MAIN_TTL';
const HANDOFF_AGENTS = 'CACHE_LIVE_CONTROL_AGENTS_TTL';

function world(on: On, initial: Record<string, string> = {}) {
  const env = new Map(Object.entries(initial));
  const commands: string[] = [];
  const logs: string[] = [];
  const process = { fails: false };
  const failures = { ttl: false, listing: false };
  const calls: string[] = [];
  const files = new Map<string, string[]>();
  on('process.run', async (_$, e) => {
    if (process.fails) throw new Error('append refused');
    for (let i = 6; i < e.argv.length; i += 2) {
      const path = `${e.argv[4]}/${e.argv[i]}`;
      files.set(path, [...(files.get(path) ?? []), e.argv[i + 1]!]);
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } };
  });
  on('ui.log', async (_$, e) => { logs.push(e.text); return { value: undefined } as never; });
  on('session.id', async () => ({ value: 'log-session' }));
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }) as never);
  const toasts: { text: string; timeoutMs?: number }[] = [];
  mock.clock(on, { now: 1_000_000_000_000 });
  on('ui.toast', async (_$, e) => {
    toasts.push({ text: e.text, timeoutMs: e.timeoutMs });
    return { value: undefined } as never;
  });
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'hello' } as never;
    return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage: null } as never;
  });
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', async (_$, e) => ({ text: e.answer }));
  on('env.get', async (_$, e) => ({ value: env.get(e.name) }));
  on('env.set', async (_$, e) => {
    if (failures.ttl && e.name === MAIN) throw new Error('TTL write refused');
    if (e.value === undefined) env.delete(e.name);
    else env.set(e.name, e.value);
    return { value: undefined };
  });
  on('agent.list', async () => { if (failures.listing) throw new Error('agent list refused'); return { value: [] } as never; });
  on('tool.call', async (_$, e) => { calls.push((e as unknown as { message: string }).message); return { result: 'sent' } as never; });
  on('command.register', async (_$, e) => {
    commands.push(e.name);
    return { value: { command: e.name } };
  });
  on('session.start', async (_$, e) => ({ cwd: e.cwd }));
  return { env, commands, toasts, logs, process, files, failures, calls };
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

function prompt(text: string) {
  return { text, wait: false, origin: { kind: 'composer' as const } };
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
      'main 5m (set by /cache, cold) · agents 1h (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL set outside this plugin, cold) · auto-raise off · resume-guard off · summaries on · warning: FORCE_PROMPT_CACHING_5M="1" is set, so every request uses 5m',
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
    expect(out.text).toMatch(/^nothing changed: "30m" is not 5m, 1h, auto, main or agents; usage: /);
  });
});

describe('options', () => {
  // The kit loads the plugin under test with its manifest's defaults and has no
  // way to hand it other options (an inline plugin is re-emitted as a module of
  // its own and cannot import this one). A non-empty mainTtl/subagentTtl is
  // covered by tests/options.test.ts and by scripts/live-proof.sh; the
  // auto-raise option is covered by hook-tests/ (scripts/test-hook-variants.sh).
  test('the default options leave both variables alone at session start', async ($, on) => {
    const w = world(on, { [AGENTS]: '1h' });
    await $.session.start(START);
    expect(w.env.has(MAIN)).toBe(false);
    expect(w.env.get(AGENTS)).toBe('1h');
    const out = await $.command.run(run(''));
    expect(out.text).toBe(
      'main automatic (settings, agent frontmatter or plan default, cold) · agents 1h (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL set outside this plugin, cold) · auto-raise off · resume-guard off · summaries on',
    );
  });
});

describe('TTL notice', () => {
  // ttlNotice defaults to false, and the kit loads the plugin with its
  // manifest's defaults (see 'options' above): the note itself, and when it is
  // due, are covered by tests/notice.test.ts and the live check.
  test('off by default: no prompt carries a note, across a TTL change, a compaction and a /clear', async ($, on) => {
    world(on, { [MAIN]: '1h' });
    const contexts: (readonly string[] | undefined)[] = [];
    on('prompt.submit', async (_$, e) => {
      contexts.push(e.context);
      return { text: e.text, context: e.context };
    });
    on('session.compact', async (_$, e) => ({ messages: e.messages }));
    await $.session.start(START);
    const first = await $.prompt.submit(prompt('one'));
    await $.command.run(run('main 5m'));
    await $.prompt.submit(prompt('two'));
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never);
    await $.prompt.submit(prompt('three'));
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await $.prompt.submit(prompt('four'));
    expect(first.text).toBe('one');
    expect(contexts).toEqual([undefined, undefined, undefined, undefined]);
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
    expect(out.text).toBe(`main 1h (ENABLE_PROMPT_CACHING_1H at launch, main chat only, cold) · agents automatic (${AGENTS_AUTO}, cold) · auto-raise off · resume-guard off · summaries on`);
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
    expect((await $.command.run(run(''))).text).toBe('main 1h (set at launch, cold) · agents 5m (set at launch, cold) · auto-raise off · resume-guard off · summaries on');
  });

  test('a variable set at launch beats the handoff; a bad handoff is named by /cache', async ($, on) => {
    const w = world(on, { [MAIN]: '5m', [HANDOFF_MAIN]: '1h', [HANDOFF_AGENTS]: '2h' });
    await $.session.start(START);
    expect(w.env.get(MAIN)).toBe('5m');
    expect(w.env.has(AGENTS)).toBe(false);
    expect(w.env.has(HANDOFF_MAIN)).toBe(false);
    expect((await $.command.run(run(''))).text).toMatch(/ · auto-raise off · resume-guard off · summaries on · CACHE_LIVE_CONTROL_AGENTS_TTL "2h" ignored: use 5m, 1h or auto$/);
  });

  test('a handoff auto keeps ENABLE_PROMPT_CACHING_1H off the main chat too', async ($, on) => {
    const w = world(on, { [ENABLE_1H]: '1', [HANDOFF_MAIN]: 'auto' });
    await $.session.start(START);
    expect(w.env.has(MAIN)).toBe(false);
    expect(w.env.has(ENABLE_1H)).toBe(false);
  });
});

describe('option variables', () => {
  // The kit gives the plugin its manifest defaults only, so the variables are what
  // sets an option here: the adapter reads each one and the options layer decides.
  const VARIABLES = {
    CACHE_LIVE_CONTROL_TTL_NOTICE: '1',
    CACHE_LIVE_CONTROL_RAISE_AFTER_EXPIRIES: '2',
    CACHE_LIVE_CONTROL_RESUME_GUARD: 'block',
    CACHE_LIVE_CONTROL_RESUME_GUARD_MIN_TOKENS: '50k',
    CACHE_LIVE_CONTROL_RESUME_GUARD_PRICE: '3',
    CACHE_LIVE_CONTROL_SUMMARIES: 'block',
  };

  test('every variable reaches the hook that decides on its option', async ($, on) => {
    const w = world(on, { ...VARIABLES, [MAIN]: '5m' });
    const contexts: (readonly string[] | undefined)[] = [];
    on('prompt.submit', async (_$, e) => {
      contexts.push(e.context);
      return { text: e.text, context: e.context };
    });
    await $.session.start(START);
    await $.prompt.submit(prompt('one'));
    expect(contexts[0]?.[0]).toMatch(/^Prompt cache: this chat's cache lives 5 minutes\./);
    expect((await $.command.run(run(''))).text).toBe(
      'main 5m (CLAUDE_CODE_PROMPT_CACHE_TTL set outside this plugin, cold) · agents automatic (' + AGENTS_AUTO + ', cold) · auto-raise counting 0 of 2 expiries · resume-guard block (floor 50k, $3/M) · summaries off (sends x-cache-live-control-summaries: block; a gateway must answer them)',
    );
    expect(w.env.get('ANTHROPIC_CUSTOM_HEADERS')).toMatch(/x-cache-live-control-summaries: block/);
  });

  test('a bad variable is named by /cache and leaves the default over the option', async ($, on) => {
    world(on, { CACHE_LIVE_CONTROL_RESUME_GUARD: 'maybe', CACHE_LIVE_CONTROL_RAISE_AFTER_EXPIRIES: ' ' });
    await $.session.start(START);
    expect((await $.command.run(run(''))).text).toMatch(/ · auto-raise off · resume-guard off · summaries on · CACHE_LIVE_CONTROL_RESUME_GUARD "maybe" ignored: use off, warn or block$/);
  });

  test('CACHE_LIVE_CONTROL_SUBAGENT_TTL sets the sub-agents at start and is consumed', async ($, on) => {
    const w = world(on, { CACHE_LIVE_CONTROL_SUBAGENT_TTL: '1h' });
    await $.session.start(START);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(w.env.has('CACHE_LIVE_CONTROL_SUBAGENT_TTL')).toBe(false);
    expect((await $.command.run(run(''))).text).toMatch(/ · agents 1h \(set at launch, cold\) · /);
  });
});

describe('warm-cache warning', () => {
  test('turn.step passes the stream through unchanged and records the request', async ($, on) => {
    world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    const r = await step($);
    expect(r.chunks).toEqual([{ kind: 'text', index: 0, text: 'hello' }]);
    expect(r.result).toEqual({ turnId: 't', index: 0, answer: 'hello', toolUses: [], stopReason: 'end_turn', usage: null });
    expect((await $.command.run(run(''))).text).toMatch(/^main 1h \(CLAUDE_CODE_PROMPT_CACHE_TTL set outside this plugin, warm 60m\) · agents automatic \(.*, cold\) · auto-raise off · resume-guard off · summaries on$/);
  });

  test('a warm change applies at once and says the cache was warm', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    await step($);
    const out = await $.command.run(run('main 5m'));
    expect(w.env.get(MAIN)).toBe('5m');
    expect(out.text).toBe("switched; main's cache was warm (60m left), the next request may rewrite it: main 5m · agents automatic");
  });

  test('a warm switch inside a main turn also toasts; the reply is unchanged', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    await $.turn.start({ text: 'count', turnId: 't' });
    await step($);
    const out = await $.command.run(run('main 5m'));
    expect(out.text).toBe("switched; main's cache was warm (60m left), the next request may rewrite it: main 5m · agents automatic");
    expect(w.toasts).toEqual([
      { text: "main's cache was warm (60m left), the next request may rewrite it — now main 5m · agents automatic", timeoutMs: 10000 },
    ]);
  });

  test('no toast once the main turn completed, or for a cold switch inside a turn', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    await $.turn.start({ text: 'count', turnId: 't' });
    expect((await $.command.run(run('agents 1h'))).text).toBe('main 1h · agents 1h');
    await step($);
    await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as never);
    const out = await $.command.run(run('main 5m'));
    expect(out.text).toBe("switched; main's cache was warm (60m left), the next request may rewrite it: main 5m · agents 1h");
    expect(w.toasts).toEqual([]);
  });

  test('an aborted main turn also ends it: no toast after', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    await $.turn.start({ text: 'count', turnId: 't' });
    await step($);
    await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' } as never);
    await $.command.run(run('main 5m'));
    expect(w.toasts).toEqual([]);
  });

  test('a warm sub-agent change applies at once and says so', async ($, on) => {
    const w = world(on, { [AGENTS]: '5m' });
    await $.session.start(START);
    await step($, 'agent-1');
    const out = await $.command.run(run('agents 1h'));
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(out.text).toBe("switched; agents' cache was warm (5m left), the next request may rewrite it: main automatic · agents 1h");
  });

  test('a cold party, or a warm one kept at its TTL, changes at once', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    await step($);
    expect((await $.command.run(run('agents 1h'))).text).toBe('main 1h · agents 1h');
    expect((await $.command.run(run('main 1h'))).text).toBe('main 1h · agents 1h');
    expect(w.env.get(AGENTS)).toBe('1h');
  });
});


describe('plugin log adapter', () => {
  for (const configured of [true, false]) test(`forced error and warning land (${configured ? 'PLUGIN_LOG_DIR' : 'HOME'})`, async ($, on) => {
    const home = '/hook-test/home';
    {
      const dir = configured ? `${home}/logs/cache-live-control` : `${home}/.local/state/cache-live-control/logs`;
      const w = world(on, { HOME: home, ...(configured ? { PLUGIN_LOG_DIR: `${home}/logs` } : {}) });
      w.failures.ttl = true;
      await $.session.start(START);
      expect((await $.command.run(run('main 1h'))).text).toBe('failed, the TTL may be unchanged: no implementation for env.set');
      await $.command.run(run('guard warn'));
      w.failures.listing = true;
      await $.tool.call({ tool: 'SendMessage', to: 'unknown', message: 'send this unchanged' } as never);
      await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
      expect(w.calls).toEqual(['send this unchanged']);
      const read = async (file: string) => (w.files.get(`${dir}/${file}`) ?? []).map((s) => JSON.parse(s));
      const errors = await read('errors.jsonl');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ plugin: 'cache-live-control', level: 'error', event: 'ttl-change-failed', where: 'hooks/cache-live-control.ts#runCommand', session: 'log-session', detail: { error: 'no implementation for env.set' } });
      const warnings = await read('warnings.jsonl');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ level: 'warning', event: 'resume-check-failed', where: 'hooks/cache-live-control.ts#checkSend', detail: { error: 'no implementation for agent.list' } });
    }
  });

  test('append rejection fallback streak and recovery leave command result unchanged', async ($, on) => {
    const home = '/hook-test/failure-home';
    {
      const w = world(on, { HOME: home, PLUGIN_LOG_DIR: `${home}/logs` });
      w.process.fails = true;
      await $.session.start(START);
      await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
      for (let i = 0; i < 2; i++) {
        w.failures.ttl = true;
        expect((await $.command.run(run('main 1h'))).text).toBe('failed, the TTL may be unchanged: no implementation for env.set');
        await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
      }
      const fallback = () => w.logs.filter((s) => s.includes('plugin log '));
      expect(fallback()).toHaveLength(1);
      expect(fallback()[0]).toContain(`${home}/logs/cache-live-control`);
      expect(fallback()[0]).toContain('process.run');
      w.process.fails = false;
      await $.command.run(run('main 1h'));
      await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
      w.process.fails = true;
      await $.command.run(run('main 1h'));
      await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
      expect(fallback()).toHaveLength(2);
    }
  });

  test('missing logging env has one exact off notice', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    w.failures.ttl = true;
    await $.command.run(run('main 1h'));
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    expect(w.logs.filter((s) => s.includes('plugin log off:'))).toEqual(['cache-live-control: plugin log off: no PLUGIN_LOG_DIR and no HOME']);
  });
});
