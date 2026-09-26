import type { On } from 'claude-code';
import { describe, expect, test } from 'claude-code/testing';

// Run with `claude plugin test plugins/cache-live-control`: the plugin loads
// from this folder under the engine's own host; `on` here sits beneath it and
// answers `$.env` and `$.command.register` from memory.

const MAIN = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
const AGENTS = 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL';

function world(on: On, initial: Record<string, string> = {}) {
  const env = new Map(Object.entries(initial));
  const commands: string[] = [];
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
  return { env, commands };
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
      'main 5m (set by /cache) · agents 1h (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL set outside this plugin) · warning: FORCE_PROMPT_CACHING_5M="1" is set, so every request uses 5m',
    );
  });

  test('a bad argument changes nothing', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    const out = await $.command.run(run('main 30m'));
    expect(w.env.get(MAIN)).toBe('1h');
    expect(w.env.has(AGENTS)).toBe(false);
    expect(out.text).toMatch(/^nothing changed, "main 30m" is not understood; usage: /);
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
      'main automatic (settings, agent frontmatter or plan default) · agents 1h (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL set outside this plugin)',
    );
  });
});
