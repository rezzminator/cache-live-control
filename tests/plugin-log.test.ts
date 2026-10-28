/// <reference path="../types/claude-code.d.ts" />
// The adapter's wiring onto the vendored plugin-log library: which doors log at which level, and what reaches the
// screen. The library itself (rows, rotation, the queue) is covered by its canonical conformance tests.
import type { EngineInterface, On } from 'claude-code';
import { register } from '../plugins/cache-live-control/hooks/cache-live-control.ts';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const exec = promisify(execFile);
async function contents(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function temp() { const d = await mkdtemp(join(tmpdir(), 'cache-plugin-log-')); dirs.push(d); return d; }
const fields = { plugin: 'cache-live-control', where: 'hooks/cache-live-control.ts#runCommand' };
async function run(argv: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  try { const { stdout, stderr } = await exec(argv[0]!, argv.slice(1), { timeout: 5000, ...options }); return { exitCode: 0, stdout, stderr }; }
  catch (error) { const e = error as Error & { code?: number; stdout?: string; stderr?: string }; return { exitCode: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }; }
}

// The engine's kit forbids Node imports. Exercise its same hook registration
// here with the real process backend; kit tests separately pin host dispatch.
function adapter(initial: Record<string, string>, options: Record<string, string | boolean> = {}) {
  const env = new Map(Object.entries(initial));
  const logs: string[] = [];
  /** The lines `$.ui.log` puts on screen: every line but one sent `to: 'debug'`. */
  const screen: string[] = [];
  const controls = {
    uiFails: false, processFails: false, ttlFails: false, listingFails: false, clockFails: false, toastFails: false, registerFails: false, registerUnbound: false,
    now: 1_000_000_000_000,
    readFails: (_name: string): boolean => false,
    writeFails: (_name: string): boolean => false,
  };
  type Handler = (engine: EngineInterface, e: Record<string, unknown>, next: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const on = ((name: string, ...args: unknown[]) => { handlers.set(name, args.at(-1) as Handler); }) as On;
  const engine = {
    env: { get: async (name: string) => { if (controls.readFails(name)) throw new Error('read refused'); return env.get(name); }, set: async (name: string, value?: string) => {
      if (controls.writeFails(name)) throw new Error('write refused');
      if (controls.ttlFails && name === 'CLAUDE_CODE_PROMPT_CACHE_TTL') throw new Error('TTL write refused');
      if (value === undefined) env.delete(name); else env.set(name, value);
    } },
    clock: { now: async () => { if (controls.clockFails) throw new Error('clock refused'); return controls.now; } },
    session: { id: async () => 'log-session' },
    command: { register: async () => { if (controls.registerUnbound) throw new Error('cache-live-control: $.command.register is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on'); if (controls.registerFails) throw new Error('register refused'); return { command: 'cache' }; } },
    agent: { list: async () => { if (controls.listingFails) throw new Error('agent list refused'); return []; } },
    ui: { log: (text: string, init?: { to?: string }) => { if (controls.uiFails) throw new Error('screen refused'); logs.push(text); if (init?.to !== 'debug') screen.push(text); }, toast: () => { if (controls.toastFails) throw new Error('toast refused'); } },
    process: { run: async (argv: readonly string[]) => {
      if (controls.processFails) throw new Error('append refused');
      return run(argv);
    } },
  } as unknown as EngineInterface;
  register(on, options);
  async function emit(name: string, e: Record<string, unknown>, next: (e: Record<string, unknown>) => Promise<Record<string, unknown>> = async (e) => e) {
    return await handlers.get(name)!(engine, e, next) as Record<string, unknown>;
  }
  const end = () => emit('session.end', { reason: 'clear', sessionId: 's', resume: {} });
  const command = (args: string) => emit('command.run', { command: 'cache', args });
  async function step(agentId?: string, tokens = 187_000) {
    const next = async function* () { yield { kind: 'text', text: 'hello' }; return { usage: agentId === undefined ? null : { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: tokens, model: 'haiku' } }; };
    const stream = handlers.get('turn.step')!(engine, { ...(agentId === undefined ? {} : { agentId }) }, next) as AsyncGenerator;
    for (;;) { const item = await stream.next(); if (item.done) return item.value; }
  }
  const removeProcess = () => { delete (engine as Partial<EngineInterface>).process; };
  return { emit, end, command, step, controls, logs, screen, env, removeProcess };
}

test.each([
  { level: 'error', event: 'registering-cache-failed', where: 'startSession', cause: 'register refused' },
  { level: 'warning', event: 'resume-check-failed', where: 'checkSend', cause: 'agent list refused' },
])('real adapter queues $level before a throwing screen', async ({ level, event, where, cause }) => {
  const home = await temp(); const a = adapter({ HOME: home });
  if (level === 'warning') {
    await a.emit('session.start', { cwd: '.' });
    await a.command('guard warn');
    a.controls.listingFails = true;
  } else a.controls.registerFails = true;
  a.controls.uiFails = true;
  const action = level === 'error'
    ? a.emit('session.start', { cwd: '.' })
    : a.emit('tool.call', { tool: 'SendMessage', to: 'unknown', message: 'sent' });
  await expect(action).rejects.toThrow('screen refused');
  await a.end();
  const text = await contents(join(home, `.local/state/cache-live-control/logs/${level === 'error' ? 'errors' : 'warnings'}.jsonl`));
  const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ level, event, where: `hooks/cache-live-control.ts#${where}`, session: 'log-session', detail: { error: cause } });
});

test('real adapter writes forced error and resume warning under configured root and HOME fallback', async () => {
  for (const configured of [true, false]) {
    const home = await temp();
    const dir = configured ? join(home, 'logs/cache-live-control') : join(home, '.local/state/cache-live-control/logs');
    const a = adapter({ HOME: home, ...(configured ? { PLUGIN_LOG_DIR: join(home, 'logs') } : {}) });
    await a.emit('session.start', { cwd: '.' });
    a.controls.ttlFails = true;
    expect((await a.command('main 1h')).text).toBe('failed, the TTL may be unchanged: TTL write refused');
    await a.command('guard warn');
    a.controls.listingFails = true;
    const calls: unknown[] = [];
    const sent = await a.emit('tool.call', { tool: 'SendMessage', to: 'unknown', message: 'unchanged body' }, async (e) => { calls.push(e.message); return { result: 'sent' }; });
    expect(sent).toEqual({ result: 'sent' }); expect(calls).toEqual(['unchanged body']);
    await a.end();
    const read = async (file: string) => (await contents(join(dir, file))).split('\n').filter(Boolean).map((s) => JSON.parse(s));
    const errors = await read('errors.jsonl'); expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ plugin: fields.plugin, level: 'error', event: 'ttl-change-failed', where: fields.where, session: 'log-session', detail: { error: 'TTL write refused' } });
    const warnings = await read('warnings.jsonl'); expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ plugin: fields.plugin, level: 'warning', event: 'resume-check-failed', where: 'hooks/cache-live-control.ts#checkSend', detail: { error: 'agent list refused' } });
    for (const row of [...errors, ...warnings]) expect(Buffer.byteLength(JSON.stringify(row) + '\n')).toBeLessThanOrEqual(4096);
  }
});

test('real adapter contains failed runs, recovery and no-directory without changing command result', async () => {
  const home = await temp(); const a = adapter({ HOME: home });
  a.controls.processFails = true; a.controls.ttlFails = true;
  await a.emit('session.start', { cwd: '.' }); await a.end();
  const fail = async () => { expect((await a.command('main 1h')).text).toBe('failed, the TTL may be unchanged: TTL write refused'); await a.end(); };
  await fail(); await fail();
  const notices = () => a.logs.filter((s) => s.includes('plugin log '));
  expect(notices()).toHaveLength(1); expect(notices()[0]).toContain(join(home, '.local/state/cache-live-control/logs')); expect(notices()[0]).toContain('append refused');
  a.controls.processFails = false; await fail();
  a.controls.processFails = true; await fail(); expect(notices()).toHaveLength(2);
  const off = adapter({}); await off.emit('session.start', { cwd: '.' }); off.controls.ttlFails = true; await off.command('main 1h'); await off.end();
  expect(off.logs).toContain('cache-live-control: plugin log off: no PLUGIN_LOG_DIR and no HOME');
});


test('each failure door preserves its outcome and records its chosen level and stable component', async () => {
  type A = ReturnType<typeof adapter>;
  type Door = { event: string; level: string; where: string; options?: Record<string, string | boolean>; initial?: Record<string, string>; before?: (a: A) => void; act?: (a: A) => Promise<unknown> };
  const main = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
  const doors: Door[] = [
    { event: 'applying-the-starting-ttls-failed', level: 'error', where: 'startSession', before: (a) => { a.controls.readFails = (n) => n === 'CACHE_LIVE_CONTROL_MAIN_TTL'; } },
    { event: 'unsetting-launch-handoff-failed', level: 'error', where: 'startSession', before: (a) => { a.controls.writeFails = (n) => n === 'CACHE_LIVE_CONTROL_MAIN_TTL'; } },
    { event: 'keeping-launch-1h-to-the-main-chat-failed', level: 'error', where: 'startSession', initial: { ENABLE_PROMPT_CACHING_1H: '1' }, before: (a) => { a.controls.writeFails = (n) => n === 'ENABLE_PROMPT_CACHING_1H'; } },
    { event: 'marking-requests-to-stop-sub-agent-summaries-failed', level: 'error', where: 'startSession', options: { summaries: 'block' }, before: (a) => { a.controls.writeFails = (n) => n === 'ANTHROPIC_CUSTOM_HEADERS'; } },
    { event: 'registering-cache-failed', level: 'error', where: 'startSession', before: (a) => { a.controls.registerFails = true; } },
    { event: 'weighing-the-wake-for-the-auto-raise-failed', level: 'warning', where: 'weighWake', options: { raiseAfterExpiries: '1' }, act: async (a) => { a.controls.clockFails = true; const out = await a.emit('prompt.submit', { text: 'sent' }); expect(out.text).toBe('sent'); } },
    { event: 'auto-raise-failed', level: 'error', where: 'weighWake', options: { raiseAfterExpiries: '1' }, initial: { [main]: '5m' }, act: async (a) => { a.controls.now += 1; await a.step(); a.controls.now += 20 * 60_000; a.controls.ttlFails = true; await a.emit('prompt.submit', { text: 'sent' }); expect(a.env.get(main)).toBe('5m'); } },
    { event: 'restarting-the-auto-raise-count-failed', level: 'error', where: 'restartRaise', act: async (a) => { a.controls.clockFails = true; await a.emit('session.compact', { trigger: 'manual', messages: [] }); } },
    { event: 'noting-a-request-for-the-resume-guard-failed', level: 'warning', where: 'agentRequest', act: async (a) => { a.controls.clockFails = true; await a.step('ag1'); } },
    { event: 'noting-the-spawn-failed', level: 'warning', where: 'spawned', act: async (a) => { a.controls.clockFails = true; const out = await a.emit('agent.spawn', { name: 'researcher' }, async () => ({ agentId: 'ag1' })); expect(out.agentId).toBe('ag1'); } },
    { event: 'resume-check-failed', level: 'warning', where: 'checkSend', act: async (a) => { await a.command('guard warn'); a.controls.listingFails = true; const out = await a.emit('tool.call', { tool: 'SendMessage', to: 'missing', message: 'sent' }); expect(out.message).toBe('sent'); } },
    { event: 'summaries-failed', level: 'error', where: 'applySettings', act: async (a) => { a.controls.writeFails = (n) => n === 'ANTHROPIC_CUSTOM_HEADERS'; expect((await a.command('summaries off')).text).toContain('summaries failed, the header may be unchanged'); } },
    { event: 'summaries-readback-failed', level: 'warning', where: 'applySettings', act: async (a) => { let reads = 0; a.controls.readFails = (n) => n === 'ANTHROPIC_CUSTOM_HEADERS' && ++reads > 1; expect((await a.command('summaries off')).text).toContain('summaries off, reading the header back failed'); } },
    { event: 'showing-toast-failed', level: 'warning', where: 'toast', initial: { [main]: '1h' }, act: async (a) => { await a.emit('turn.start', {}); await a.step(); a.controls.toastFails = true; expect((await a.command('main 5m')).text).toContain('switched;'); expect(a.env.get(main)).toBe('5m'); } },
    { event: 'ttl-change-failed', level: 'error', where: 'runCommand', act: async (a) => { a.controls.ttlFails = true; expect((await a.command('main 1h')).text).toContain('failed, the TTL may be unchanged'); } },
    { event: 'reading-settings-state-failed', level: 'warning', where: 'runCommand', act: async (a) => { a.controls.readFails = (n) => n === main; expect((await a.command('guard block')).text).toContain('settings applied, reading their state failed'); } },
    { event: 'command-failed', level: 'error', where: 'runCommand', act: async (a) => { a.controls.clockFails = true; expect((await a.command('')).text).toContain('failed, the TTL may be unchanged'); } },
    { event: 'noting-a-main-request-for-the-warm-cache-warning-failed', level: 'warning', where: 'turn.step', act: async (a) => { a.controls.readFails = (n) => n === main; await a.step(); } },
    { event: 'building-the-ttl-notice-failed', level: 'warning', where: 'prompt.submit', options: { ttlNotice: true }, act: async (a) => { a.controls.readFails = (n) => n === main; expect((await a.emit('prompt.submit', { text: 'sent' })).text).toBe('sent'); } },
  ];
  for (const door of doors) {
    const home = await temp(); const a = adapter({ HOME: home, ...door.initial }, door.options);
    door.before?.(a); await a.emit('session.start', { cwd: '.' }); await a.end();
    await door.act?.(a); await a.end();
    const dir = join(home, '.local/state/cache-live-control/logs');
    const text = await contents(join(dir, door.level === 'error' ? 'errors.jsonl' : 'warnings.jsonl'));
    const rows = text.split('\n').filter(Boolean).map((s) => JSON.parse(s)).filter((r) => r.event === door.event);
    expect.soft(rows.length, door.event).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ level: door.level, where: `hooks/cache-live-control.ts#${door.where}`, detail: { error: expect.any(String) } });
  }
});

test('a command registration refused for want of a bound session logs info, no error row and no screen line; any other refusal still logs an error', async () => {
  const home = await temp(); const a = adapter({ HOME: home });
  a.controls.registerUnbound = true;
  await a.emit('session.start', { cwd: '.' }); await a.end();
  const dir = join(home, '.local/state/cache-live-control/logs');
  expect(await contents(join(dir, 'errors.jsonl'))).not.toContain('registering-cache-failed');
  const rows = (await contents(join(dir, 'info.jsonl'))).split('\n').filter(Boolean).map((s) => JSON.parse(s)).filter((r) => r.event === 'registering-cache-skipped');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ level: 'info', where: 'hooks/cache-live-control.ts#startSession' });
  expect(a.logs.join('\n')).not.toContain('registering /cache failed');
  const other = adapter({ HOME: home }); other.controls.registerFails = true;
  await other.emit('session.start', { cwd: '.' }); await other.end();
  expect(await contents(join(dir, 'errors.jsonl'))).toContain('registering-cache-failed');
});

test('resume decisions retain block, override and warn behavior with their specified rows', async () => {
  for (const [mode, body, event, level] of [['block', 'carry on', 'resume-blocked', 'info'], ['block', '[resume-anyway] carry on', 'resumed-anyway', 'warning'], ['warn', 'carry on', 'resume-warned', 'info']] as const) {
    const home = await temp(); const a = adapter({ HOME: home });
    await a.emit('session.start', { cwd: '.' });
    await a.command(`guard ${mode}`);
    await a.emit('agent.spawn', { name: 'researcher' }, async () => ({ agentId: 'ag1' }));
    await a.step('ag1'); a.controls.now += 20 * 60_000;
    const calls: unknown[] = [];
    const out = await a.emit('tool.call', { tool: 'SendMessage', to: 'ag1', message: body }, async (e) => { calls.push(e.message); return { result: 'sent' }; });
    if (event === 'resume-blocked') { expect(out.deny).toContain('Not sent.'); expect(calls).toEqual([]); }
    else { expect(out.deny).toBeUndefined(); expect(calls).toEqual(['carry on']); }
    await a.end();
    const text = await contents(join(home, `.local/state/cache-live-control/logs/${level === 'warning' ? 'warnings' : 'info'}.jsonl`));
    const rows = text.split('\n').filter(Boolean).map((s) => JSON.parse(s)).filter((r) => r.event === event);
    expect.soft(rows).toHaveLength(1); expect.soft(rows[0]).toMatchObject({ level, where: 'hooks/cache-live-control.ts#checkSend', detail: { agent: 'ag1' } });
  }
});


test('real adapter unavailable process and failed directory lookup remain visible and never change cache work', async () => {
  const home = await temp();
  const missing = adapter({ HOME: home }); missing.removeProcess();
  await missing.emit('session.start', { cwd: '.' });
  missing.controls.ttlFails = true;
  expect((await missing.command('main 5m')).text).toBe('failed, the TTL may be unchanged: TTL write refused');
  await missing.end();
  expect.soft(missing.logs.filter((s) => s.includes('plugin log '))).toHaveLength(1);
  expect.soft(missing.logs.join('\n')).toContain(join(home, '.local/state/cache-live-control/logs'));
  expect.soft(missing.logs.join('\n')).toContain('run');
  const unreadable = adapter({ HOME: home, PLUGIN_LOG_DIR: join(home, 'configured') });
  unreadable.controls.readFails = (n) => n === 'PLUGIN_LOG_DIR';
  await unreadable.emit('session.start', { cwd: '.' });
  unreadable.controls.ttlFails = true;
  await unreadable.command('main 1h'); await unreadable.end();
  const notices = unreadable.logs.filter((s) => s.includes('plugin log initialization/row failed:'));
  expect.soft(notices).toHaveLength(1); expect.soft(notices[0]).toContain('read refused');
});

test('the plugin log failing-streak line reaches the screen, once per streak', async () => {
  const home = await temp(); const a = adapter({ HOME: home });
  a.controls.processFails = true; a.controls.ttlFails = true;
  await a.emit('session.start', { cwd: '.' });
  for (let i = 0; i < 2; i++) { await a.command('main 1h'); await a.end(); }
  const streak = () => a.screen.filter((s) => s.startsWith('cache-live-control: plugin log '));
  expect(streak()).toHaveLength(1);
  expect(streak()[0]).toContain('append refused');
  a.controls.processFails = false; await a.command('main 1h'); await a.end();
  a.controls.processFails = true; await a.command('main 1h'); await a.end();
  expect(streak()).toHaveLength(2);
});

test('a warning row never reaches the screen, nor its log line', async () => {
  const home = await temp(); const a = adapter({ HOME: home });
  await a.emit('session.start', { cwd: '.' });
  await a.command('guard warn');
  a.controls.listingFails = true;
  await a.emit('tool.call', { tool: 'SendMessage', to: 'unknown', message: 'sent' });
  a.controls.ttlFails = true;
  await a.command('main 1h');
  await a.end();
  const warnings = (await contents(join(home, '.local/state/cache-live-control/logs/warnings.jsonl'))).split('\n').filter(Boolean).map((s) => JSON.parse(s));
  expect(warnings.map((r) => r.event)).toContain('resume-check-failed');
  expect(a.screen.filter((s) => s.includes('checking the resume'))).toEqual([]);
  expect(a.screen.filter((s) => s.includes('plugin log '))).toEqual([]);
});
