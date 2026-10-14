/// <reference path="../types/claude-code.d.ts" />
import type { EngineInterface, On } from 'claude-code';
import { register } from '../plugins/cache-live-control/hooks/cache-live-control.ts';
import { execFile } from 'node:child_process';
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { appendArgv, levelRow, pluginLogDir, PluginLogQueue, PLUGIN_LOG_CAP_BYTES, ROW_MAX_BYTES } from '../plugins/cache-live-control/src/plugin-log.ts';

const exec = promisify(execFile);
async function contents(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
async function size(path: string) {
  try { return (await stat(path)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function temp() { const d = await mkdtemp(join(tmpdir(), 'cache-plugin-log-')); dirs.push(d); return d; }
const fields = { plugin: 'cache-live-control', level: 'error' as const, event: 'ttl-change-failed', msg: 'write refused', where: 'hooks/cache-live-control.ts#runCommand' };
const now = 1791991231123;
const row = (level: 'error' | 'warning' | 'info') => ({ level, row: levelRow({ ...fields, level }, now) });
async function run(argv: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  try { const { stdout, stderr } = await exec(argv[0]!, argv.slice(1), { timeout: 5000, ...options }); return { exitCode: 0, stdout, stderr }; }
  catch (error) { const e = error as Error & { code?: number; stdout?: string; stderr?: string }; return { exitCode: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }; }
}

test('levelRow ordered contract and bounded UTF-8 rows', () => {
  for (const extra of [{}, { session: 's1', detail: { error: 'write refused' } }, { msg: '😀\\\n'.repeat(5000), detail: { error: 'x'.repeat(9000) } }, { event: 'e'.repeat(9000), where: 'w'.repeat(9000), session: 's'.repeat(9000) }]) {
    const input = { ...fields, ...extra };
    const text = levelRow(input, now);
    const parsed = JSON.parse(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ROW_MAX_BYTES);
    expect(parsed.ts).toBe('2026-10-14T15:20:31.123Z');
    expect(Object.keys(parsed)).toEqual(['ts', 'plugin', 'level', 'event', 'msg', 'where', ...('session' in extra ? ['session'] : []), ...('detail' in extra || Buffer.byteLength(JSON.stringify({ ts: parsed.ts, ...input }) + '\n') > ROW_MAX_BYTES ? ['detail'] : [])]);
    expect(parsed.level).toBe('error');
    for (const key of ['plugin', 'event', 'msg', 'where']) expect(parsed[key].length).toBeGreaterThan(0);
    if (Buffer.byteLength(JSON.stringify({ ts: parsed.ts, ...input }) + '\n') > ROW_MAX_BYTES) expect(parsed.detail).toEqual({ truncated: true, bytes: Buffer.byteLength(JSON.stringify({ ts: parsed.ts, ...input }) + '\n') });
    else expect(parsed).toEqual({ ts: '2026-10-14T15:20:31.123Z', ...input });
  }
  expect(ROW_MAX_BYTES).toBe(4096);
});

test('pluginLogDir chooses configured root, HOME fallback or no directory', () => {
  for (const [root, home, expected] of [['/x/logs', '/h/u', '/x/logs/auto-effort'], [undefined, '/h/u', '/h/u/.local/state/auto-effort/logs'], [undefined, undefined, undefined]] as const) expect(pluginLogDir(root, home, 'auto-effort')).toBe(expected);
});

test('APPEND_SCRIPT writes all levels with private modes and literal argv', async () => {
  for (const existing of [false, true]) {
    const parent = await temp(); await chmod(parent, 0o755);
    const legacy = join(parent, 'legacy.log'); await writeFile(legacy, 'legacy', { mode: 0o644 });
    const d = join(parent, "logs ' $(echo no)");
    if (existing) {
      await mkdir(d, { mode: 0o755 });
      for (const file of ['errors', 'warnings', 'info']) {
        await writeFile(join(d, `${file}.jsonl`), '', { mode: 0o644 });
        await writeFile(join(d, `${file}.jsonl.1`), `prior-${file}\n`, { mode: 0o644 });
      }
    }
    for (const argv of appendArgv(d, fields.plugin, ['error', 'warning', 'info'].map((l) => row(l as 'error' | 'warning' | 'info')))) expect((await run(argv)).exitCode).toBe(0);
    for (const [level, file] of [['error', 'errors'], ['warning', 'warnings'], ['info', 'info']] as const) {
      expect(await contents(join(d, `${file}.jsonl`))).toBe(row(level).row);
      expect.soft((await stat(join(d, `${file}.jsonl`))).mode & 0o777).toBe(0o600);
      if (existing) {
        expect.soft((await stat(join(d, `${file}.jsonl.1`))).mode & 0o777).toBe(0o600);
        expect(await contents(join(d, `${file}.jsonl.1`))).toBe(`prior-${file}\n`);
      }
    }
    expect.soft((await stat(d)).mode & 0o777).toBe(0o700);
    expect((await stat(parent)).mode & 0o777).toBe(0o755);
    expect((await stat(legacy)).mode & 0o777).toBe(0o644);
    expect(await contents(legacy)).toBe('legacy');
  }
});

test.each([
  { relative: false, existing: false }, { relative: true, existing: false },
  { relative: false, existing: true }, { relative: true, existing: true },
])('APPEND_SCRIPT appends private rows with BSD chmod: %j', async ({ relative, existing }) => {
  const parent = await temp();
  const bin = join(parent, 'bin'); await mkdir(bin);
  const trace = join(parent, 'chmod.calls');
  await writeFile(join(bin, 'chmod'), `#!/bin/sh
for arg do
  case "$arg" in
    --) printf 'chmod: --: No such file or directory\\n' >&2; exit 1;;
    -*) printf 'chmod: illegal option -- %s\\n' "$arg" >&2; exit 1;;
  esac
done
printf '%s\\n' "$*" >> "$BSD_CHMOD_TRACE"
exec /bin/chmod "$@"
`, { mode: 0o755 });
  const configured = relative ? "-logs ' $(echo no)" : join(parent, "logs ' $(echo no)");
  const dir = pluginLogDir(configured, undefined, fields.plugin)!;
  const disk = relative ? join(parent, dir) : dir;
  const capped = 'x'.repeat(PLUGIN_LOG_CAP_BYTES + 1);
  if (existing) {
    await mkdir(disk, { recursive: true, mode: 0o755 });
    for (const file of ['errors', 'warnings', 'info']) {
      await writeFile(join(disk, `${file}.jsonl`), file === 'info' ? '' : capped, { mode: 0o644 });
      await writeFile(join(disk, `${file}.jsonl.1`), `prior-${file}\n`, { mode: 0o644 });
    }
  }
  const rows = [row('error'), row('warning'), row('info')];
  const result = await run(appendArgv(dir, fields.plugin, rows)[0]!, {
    cwd: parent, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, BSD_CHMOD_TRACE: trace },
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(await readFile(join(disk, 'errors.jsonl'), 'utf8')).toBe(rows[0]!.row);
  expect(await readFile(join(disk, 'info.jsonl'), 'utf8')).toBe(rows[2]!.row);
  const warnings = await readFile(join(disk, 'warnings.jsonl'), 'utf8');
  if (existing) {
    const parsed = warnings.trim().split('\n').map((line) => JSON.parse(line));
    expect(parsed.map((r) => r.event)).toEqual(['log-capped', 'log-capped', fields.event]);
    expect(warnings.endsWith(rows[1]!.row)).toBe(true);
    for (const file of ['errors', 'warnings', 'info']) {
      expect(await readFile(join(disk, `${file}.jsonl.1`), 'utf8')).toBe(file === 'info' ? 'prior-info\n' : capped);
      expect((await stat(join(disk, `${file}.jsonl.1`))).mode & 0o777).toBe(0o600);
    }
  } else expect(warnings).toBe(rows[1]!.row);
  for (const file of ['errors', 'warnings', 'info']) expect((await stat(join(disk, `${file}.jsonl`))).mode & 0o777).toBe(0o600);
  expect((await stat(disk)).mode & 0o777).toBe(0o700);
  const calls = (await readFile(trace, 'utf8')).trim().split('\n');
  expect(calls[0]).toBe(`700 ${relative ? './' : ''}${dir}`);
  if (existing) expect(calls).toContain(`600 ${relative ? './' : ''}${dir}/info.jsonl.1`);
});

test('APPEND_SCRIPT refuses nonregular backup leaves without touching foreign objects', async () => {
  for (const kind of ['dangling-symlink', 'directory']) {
    const parent = await temp(); const d = join(parent, 'logs'); await mkdir(d, { mode: 0o700 });
    const foreign = join(parent, 'foreign.log'); await writeFile(foreign, 'foreign unchanged\n', { mode: 0o644 });
    const backup = join(d, 'errors.jsonl.1');
    if (kind === 'directory') await mkdir(backup, { mode: 0o755 });
    else await symlink(join(parent, 'missing'), backup);
    const result = await run(appendArgv(d, fields.plugin, [row('error')])[0]!);
    expect.soft(result.exitCode).not.toBe(0);
    expect.soft(result.stderr).toContain(backup);
    expect.soft(await contents(join(d, 'errors.jsonl'))).toBe('');
    expect(await contents(foreign)).toBe('foreign unchanged\n');
    expect((await stat(foreign)).mode & 0o777).toBe(0o644);
    if (kind === 'directory') expect((await stat(backup)).mode & 0o777).toBe(0o755);
  }
});

test('APPEND_SCRIPT renames capped level and appends contract log-capped warning', async () => {
  const d = await temp();
  expect(PLUGIN_LOG_CAP_BYTES).toBe(20_971_520);
  await writeFile(join(d, 'errors.jsonl'), 'x'.repeat(20_971_521));
  await writeFile(join(d, 'warnings.jsonl.1'), 'old warnings unchanged\n', { mode: 0o644 });
  expect((await run(appendArgv(d, fields.plugin, [row('error')])[0]!)).exitCode).toBe(0);
  expect.soft((await stat(join(d, 'warnings.jsonl.1'))).mode & 0o777).toBe(0o600);
  expect(await contents(join(d, 'warnings.jsonl.1'))).toBe('old warnings unchanged\n');
  expect(await size(join(d, 'errors.jsonl.1'))).toBe(20_971_521);
  expect(await contents(join(d, 'errors.jsonl'))).toBe(row('error').row);
  const warningText = await contents(join(d, 'warnings.jsonl'));
  const warning = JSON.parse(warningText);
  expect(warning).toMatchObject({ plugin: fields.plugin, level: 'warning', event: 'log-capped', where: 'src/plugin-log.ts#APPEND_SCRIPT', detail: { file: 'errors.jsonl', bytes: 20_971_521 } });
  expect(warning.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(Buffer.byteLength(warningText)).toBeLessThanOrEqual(4096);
});

test.skipIf(process.getuid?.() === 0)('APPEND_SCRIPT reports unwritable directory (skip-because:superuser)', async () => {
  for (const kind of ['directory', 'file']) {
    const d = await temp(); const target = kind === 'directory' ? d : join(d, 'errors.jsonl');
    if (kind === 'file') await writeFile(target, 'unchanged\n');
    await chmod(target, kind === 'directory' ? 0o500 : 0o400);
    const result = await run(appendArgv(d, fields.plugin, [row('error')])[0]!);
    expect((await stat(target)).mode & 0o777).toBe(kind === 'directory' ? 0o500 : 0o400);
    await chmod(target, kind === 'directory' ? 0o700 : 0o600);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(d);
    if (kind === 'file') expect(await contents(target)).toBe('unchanged\n');
  }
});

test('APPEND_SCRIPT reports failed lookup/write rather than absence', async () => {
  const d = await temp();
  const file = join(d, 'not-directory'); await writeFile(file, 'x');
  const result = await run(appendArgv(file, fields.plugin, [row('warning')])[0]!);
  expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain(file);
});

test('PluginLogQueue serializes concurrent flushes and batches at 64 rows', async () => {
  const d = await temp(); const notices: string[] = []; const queue = new PluginLogQueue(d, fields.plugin, (s) => notices.push(s));
  for (let i = 0; i < 130; i++) queue.add(row('error'));
  const sizes: number[] = []; let active = 0; let peak = 0;
  const runner = async (argv: readonly string[]) => { active++; peak = Math.max(peak, active); sizes.push((argv.length - 6) / 2); const result = await run(argv); active--; return result; };
  await Promise.all([queue.flush(runner), queue.flush(runner)]);
  expect(sizes).toEqual([64, 64, 2]); expect(peak).toBe(1); expect(notices).toEqual([]);
  expect((await contents(join(d, 'errors.jsonl'))).split('\n').filter(Boolean)).toHaveLength(130);
  expect(appendArgv(d, fields.plugin, Array.from({ length: 65 }, () => row('error'))).map((a) => (a.length - 6) / 2)).toEqual([64, 1]);
});

test('PluginLogQueue contains rejection/nonzero failures, counts dropped rows and rearms after success', async () => {
  const notices: string[] = []; const queue = new PluginLogQueue('/logs/cache-live-control', fields.plugin, (s) => notices.push(s));
  queue.add(row('error')); queue.add(row('warning'));
  expect(await queue.flush(async () => { throw new Error('cannot start'); })).toMatchObject({ dropped: 2 });
  queue.add(row('info')); await queue.flush(async () => ({ exitCode: 1, stdout: '', stderr: 'disk full\nmore' }));
  expect(notices).toHaveLength(1); expect(notices[0]).toContain('/logs/cache-live-control'); expect(notices[0]).toContain('cannot start'); expect(notices[0]).toContain('2');
  queue.add(row('info')); await queue.flush(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  queue.add(row('error')); await queue.flush(async () => ({ exitCode: 1, stdout: '', stderr: 'disk full\nmore' }));
  expect(notices).toHaveLength(2); expect(notices[1]).toContain('disk full');
  let calls = 0; await queue.flush(async () => { calls++; return { exitCode: 0, stdout: '', stderr: '' }; }); expect(calls).toBe(0);
});

test('PluginLogQueue missing env notice uses exact off message once', async () => {
  const notices: string[] = []; const queue = new PluginLogQueue(undefined, fields.plugin, (s) => notices.push(s));
  for (let i = 0; i < 2; i++) { queue.add(row('info')); await queue.flush(run); }
  expect(notices).toEqual(['plugin log off: no PLUGIN_LOG_DIR and no HOME']);
});

test('APPEND_SCRIPT concurrent writers preserve complete JSONL rows', async () => {
  const d = await temp(); const rows = Array.from({ length: 128 }, () => row('info'));
  await Promise.all([0, 1].map(async () => { for (const argv of appendArgv(d, fields.plugin, rows)) expect((await run(argv)).exitCode).toBe(0); }));
  const lines = (await contents(join(d, 'info.jsonl'))).trimEnd().split('\n');
  expect(lines).toHaveLength(256); for (const line of lines) expect(JSON.parse(line).event).toBe(fields.event);
});

test('APPEND_SCRIPT bounds warnings generated while capping another level', async () => {
  for (const session of [undefined, 's"\\\n😀 $(touch nope)']) {
    const d = await temp(); await chmod(d, 0o755);
    for (const [file, text] of [['errors', 'x'], ['warnings', 'w']] as const) {
      await writeFile(join(d, `${file}.jsonl`), text.repeat(20_971_521), { mode: 0o644 });
      await writeFile(join(d, `${file}.jsonl.1`), 'old', { mode: 0o644 });
    }
    const trigger = levelRow({ ...fields, ...(session === undefined ? {} : { session }), detail: { session: 'fake session only inside detail', nested: { session: 'also fake' } } }, now);
    expect((await run(appendArgv(d, fields.plugin, [{ level: 'error', row: trigger }])[0]!)).exitCode).toBe(0);
    expect(await size(join(d, 'warnings.jsonl.1'))).toBe(20_971_521);
    const warningText = await contents(join(d, 'warnings.jsonl'));
    expect(Buffer.byteLength(warningText)).toBeLessThan(4096);
    const warnings = warningText.trimEnd().split('\n').map((s) => JSON.parse(s));
    expect(warnings.map((r) => r.detail.file)).toEqual(['warnings.jsonl', 'errors.jsonl']);
    for (const warning of warnings) {
      expect(warning).toMatchObject({ ts: '2026-10-14T15:20:31.123Z', event: 'log-capped', plugin: fields.plugin, level: 'warning', where: 'src/plugin-log.ts#APPEND_SCRIPT' });
      expect.soft(warning.session).toBe(session);
      expect(Object.keys(warning)).toEqual(['ts', 'plugin', 'level', 'event', 'msg', 'where', ...(session === undefined ? [] : ['session']), 'detail']);
    }
    expect.soft((await stat(d)).mode & 0o777).toBe(0o700);
    for (const file of ['errors.jsonl', 'warnings.jsonl', 'errors.jsonl.1', 'warnings.jsonl.1']) expect.soft((await stat(join(d, file))).mode & 0o777).toBe(0o600);
    expect(await contents(join(d, 'errors.jsonl'))).toBe(trigger);
  }
});

test('APPEND_SCRIPT bounds a cap warning with a near-limit known session', async () => {
  for (const session of ['😀"\\\n'.repeat(1500), 'x'.repeat(9000), '\\u1234\ud800'.repeat(1500)]) {
    const d = await temp();
    for (const file of ['errors', 'warnings']) await writeFile(join(d, `${file}.jsonl`), 'x'.repeat(20_971_521));
    const trigger = levelRow({ ...fields, event: 'e', msg: 'm', where: 'w', session }, now);
    const triggerSession = JSON.parse(trigger).session as string;
    expect((await run(appendArgv(d, fields.plugin, [{ level: 'error', row: trigger }])[0]!)).exitCode).toBe(0);
    const text = await contents(join(d, 'warnings.jsonl'));
    const lines = text.trimEnd().split('\n'); expect(lines).toHaveLength(2);
    for (const [i, file] of ['warnings.jsonl', 'errors.jsonl'].entries()) {
      const original = { ts: '2026-10-14T15:20:31.123Z', plugin: fields.plugin, level: 'warning', event: 'log-capped', msg: 'level file moved aside at size cap', where: 'src/plugin-log.ts#APPEND_SCRIPT', session: triggerSession, detail: { file, bytes: 20_971_521 } };
      const originalBytes = Buffer.byteLength(JSON.stringify(original) + '\n');
      expect(originalBytes).toBeGreaterThan(4096);
      const warning = JSON.parse(lines[i]!);
      expect.soft(Buffer.byteLength(lines[i]! + '\n')).toBeLessThanOrEqual(4096);
      expect.soft(warning.detail).toEqual({ truncated: true, bytes: originalBytes });
      expect(typeof warning.session).toBe('string');
      expect(triggerSession.startsWith(warning.session)).toBe(true);
      expect(warning.session.length).toBeGreaterThan(0);
      expect(warning.session).not.toContain('�');
      expect(warning.msg.length).toBeGreaterThan(0);
    }
  }
});

test.skipIf(process.getuid?.() !== 0)('APPEND_SCRIPT chmod EPERM is contained using a real non-root process (skip-because:root-fixture-setup)', async () => {
  const parent = await temp(); await chmod(parent, 0o755);
  const rootDir = join(parent, 'root-owned'); await mkdir(rootDir); await chmod(rootDir, 0o777);
  const ownDir = join(parent, 'nonroot-owned'); await mkdir(ownDir, { mode: 0o700 }); await chown(ownDir, 65534, 65534);
  const rootFile = join(ownDir, 'errors.jsonl'); await writeFile(rootFile, 'unchanged\n', { mode: 0o666 }); await chmod(rootFile, 0o666);
  const backupDir = join(parent, 'backup-owned-by-root'); await mkdir(backupDir, { mode: 0o700 }); await chown(backupDir, 65534, 65534);
  const backup = join(backupDir, 'errors.jsonl.1'); await writeFile(backup, 'foreign backup unchanged\n', { mode: 0o644 });
  for (const dir of [rootDir, ownDir, backupDir]) {
    const before = await contents(join(dir, 'errors.jsonl'));
    const notices: string[] = []; const queue = new PluginLogQueue(dir, fields.plugin, (s) => notices.push(s));
    for (let i = 0; i < 2; i++) {
      queue.add(row('error'));
      expect.soft(await queue.flush((argv) => run(['/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', ...argv]))).toMatchObject({ written: 0, dropped: 1 });
    }
    expect.soft(notices).toHaveLength(1);
    expect.soft(notices[0]).toContain(dir);
    expect.soft(notices.join('\n')).toContain(dir === backupDir ? 'not writable' : 'Operation not permitted');
    expect.soft(await contents(join(dir, 'errors.jsonl'))).toBe(before);
    if (dir === backupDir) {
      expect(await contents(backup)).toBe('foreign backup unchanged\n');
      expect((await stat(backup)).mode & 0o777).toBe(0o644);
    }
  }
});



// The engine's kit forbids Node imports. Exercise its same hook registration
// here with the real process backend; kit tests separately pin host dispatch.
function adapter(initial: Record<string, string>, options: Record<string, string | boolean> = {}) {
  const env = new Map(Object.entries(initial));
  const logs: string[] = [];
  const controls = {
    processFails: false, ttlFails: false, listingFails: false, clockFails: false, toastFails: false, registerFails: false,
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
    command: { register: async () => { if (controls.registerFails) throw new Error('register refused'); return { command: 'cache' }; } },
    agent: { list: async () => { if (controls.listingFails) throw new Error('agent list refused'); return []; } },
    ui: { log: (text: string) => { logs.push(text); }, toast: () => { if (controls.toastFails) throw new Error('toast refused'); } },
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
  return { emit, end, command, step, controls, logs, env, removeProcess };
}

test('real adapter writes forced error, resume warning and heartbeat under configured root and HOME fallback', async () => {
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
    const info = await read('info.jsonl'); expect(info).toHaveLength(1);
    expect(info[0]).toEqual({ ts: '2001-09-09T01:46:40.000Z', plugin: fields.plugin, level: 'info', event: 'logger-ready', msg: 'plugin logger ready', where: 'hooks/cache-live-control.ts#session.start', session: 'log-session', detail: { version: '0.6.1', dir_source: configured ? 'PLUGIN_LOG_DIR' : 'fallback' } });
    for (const row of [...errors, ...warnings, ...info]) expect(Buffer.byteLength(JSON.stringify(row) + '\n')).toBeLessThanOrEqual(4096);
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
  const off = adapter({}); await off.emit('session.start', { cwd: '.' }); await off.end();
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
  expect((await missing.command('main 5m')).text).toBe('main 5m · agents automatic');
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

test('append refuses aliased directory and level endpoints without changing foreign data', async () => {
  
  for (const leaf of ['directory', 'errors.jsonl', 'warnings.jsonl', 'info.jsonl', 'errors.jsonl.1', 'warnings.jsonl.1', 'info.jsonl.1']) {
    const parent = await temp();
    const outside = join(parent, 'outside');
    await mkdir(outside, { mode: 0o755 });
    const sentinel = join(outside, 'sentinel');
    await writeFile(sentinel, 'protected', { mode: 0o644 });
    const d = join(parent, 'logs');
    if (leaf === 'directory') await symlink(outside, d);
    else { await mkdir(d); await symlink(sentinel, join(d, leaf)); }
    const result = await run(appendArgv(d, fields.plugin, [row('error')])[0]!);
    expect(result.exitCode, leaf).not.toBe(0);
    expect(result.stderr, leaf).toContain('symlink');
    expect(await readFile(sentinel, 'utf8'), leaf).toBe('protected');
    expect((await stat(sentinel)).mode & 0o777, leaf).toBe(0o644);
    expect((await stat(outside)).mode & 0o777, leaf).toBe(0o755);
  }
});
