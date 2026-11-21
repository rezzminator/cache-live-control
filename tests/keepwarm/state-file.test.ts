import { expect, test } from 'vitest';
import * as status from '../../plugins/cache-live-control/src/keepwarm/status.ts';
import type { ReasonCode } from '../../plugins/cache-live-control/src/keepwarm/decision.ts';
import { Harness } from './stand-in.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const run = promisify(execFile);
const groups = {
  warming: ['eligible', 'in-flight'],
  stopped: ['poke-limit', 'budget', 'poke-failed', 'timer-failed', 'stale', 'ended'],
  off: ['off'],
  on: ['agent-not-waiting', 'busy', 'inventory-unknown', 'nothing-pending', 'usage-unknown', 'usage-invalid', 'small', '1h-unproven', 'cache-cold', 'expiry-safety', 'wake-unknown', 'cannot-wake', 'imminent', 'marginal', 'resumed', 'idle'],
} as const;
for (const [state, reasons] of Object.entries(groups)) test.each(reasons)('v1 maps %s to ' + state, reason => {
  const view: status.StatusView = { enabled: reason !== 'off', source: 'session', reason: reason as ReasonCode, pokes: { count: 2, max: 4 }, items: [{ kind: 'agent', label: 'Private label', firstSeenAt: 10 }], now: 100, warms: 2, nextInMs: 25, ttl: '5m', ttlSource: 'env', context: 50000, ledger: { context: 50000, ttl: '5m', spent: 200, warms: 2, allowance: 57500, protecting: 62500, remaining: 57300 }, session: { spent: 200, warms: 2, episodes: 0, estimatedNet: 0, unknown: 0 }, lastOutcome: null };
  expect(status.sessionState(view, 'main-1')).toEqual({ v: 1, sessionId: 'main-1', updatedAt: 100, enabled: reason !== 'off', source: 'session', state, reason, pokes: { count: 2, max: 4 }, nextAt: state === 'warming' ? 125 : null, protectingTokensEq: 62500 });
});
test('a main status change after a quiet idle publishes the current clock', async () => {
  const h = new Harness({}, { HOME: '/state/user' }), records: any[] = [];
  (h.engine as any).process.run = async (argv: string[]) => { records.push(JSON.parse(argv[5]!)); return { exitCode: 0, stdout: '', stderr: '' }; };
  await h.start(); h.now += 600000;
  await h.emit('prompt.submit', { text: 'go on' }); await h.settle();
  expect(records.at(-1)).toMatchObject({ updatedAt: h.now, state: 'on', reason: 'busy' });
});
test('every off toggle replacement is internally consistent', async () => {
  const h = new Harness({}, { HOME: '/state/user' }), records: any[] = [];
  (h.engine as any).process.run = async (argv: string[]) => { records.push(JSON.parse(argv[5]!)); return { exitCode: 0, stdout: '', stderr: '' }; };
  await h.start(); await h.command('off');
  const off = records.filter(record => record.reason === 'off');
  expect(off.length).toBeGreaterThan(0);
  expect(off.every(record => record.enabled === false && record.state === 'off' && record.source === 'session')).toBe(true);
});
test('main session publishes atomic v1 replacements, toggles, and deletes on end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keepwarm-state-')), logs = await mkdtemp(join(tmpdir(), 'keepwarm-logs-'));
  try {
    // The runner below is real for every command, the log writer included, so the log goes to this test's own directory.
    const h = new Harness({}, { CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR: dir, PLUGIN_LOG_DIR: logs });
    (h.engine as any).plugin = { root: resolve('plugins/cache-live-control') };
    (h.engine as any).process = { run: async (argv: string[]) => {
      try { const result = await run(argv[0]!, argv.slice(1), {}); return { exitCode: 0, ...result }; }
      catch (error: any) { return { exitCode: error.code ?? 1, stdout: error.stdout, stderr: error.stderr ?? String(error) }; }
    } };
    const path = join(dir, h.id + '.json');
    const record = async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; return undefined; } };
    await h.start(); await h.settle();
    expect(await record()).toMatchObject({ v: 1, sessionId: h.id, enabled: true, source: 'launch', state: 'on', reason: 'idle', nextAt: null, protectingTokensEq: null });
    expect((await record()).pid).toBe(process.pid);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await h.step(); await h.stop(); await h.settle();
    expect(await record()).toMatchObject({ state: 'warming', reason: 'eligible', pokes: { count: 0, max: 4 }, nextAt: h.now + 240000, protectingTokensEq: 62183.75 });
    const reads = Array.from({ length: 30 }, async () => { for (let i = 0; i < 10; i++) expect((await record()).v).toBe(1); });
    await h.command('off'); await Promise.all(reads);
    expect(await record()).toMatchObject({ enabled: false, source: 'session', state: 'off', reason: 'off', nextAt: null });
    expect(await readdir(dir)).toEqual([h.id + '.json']);
    await writeFile(join(dir, `.${h.id}.killed-writer.tmp`), '{');
    await writeFile(join(dir, '.other-session.killed-writer.tmp'), '{');
    await h.emit('session.end', { reason: 'exit' });
    expect(await readdir(dir)).toEqual(['.other-session.killed-writer.tmp']);
    expect(await readdir(logs)).toEqual(['cache-live-control']);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(logs, { recursive: true, force: true }); }
});

test.each([
  [{ CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR: '/state/override', XDG_STATE_HOME: '/state/xdg', HOME: '/state/user' }, '/state/override', undefined],
  [{ CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR: ' ', XDG_STATE_HOME: '/state/xdg', HOME: '/state/user' }, '/state/xdg/cache-live-control/keepwarm/sessions', undefined],
  [{ HOME: '/state/user' }, '/state/user/.local/state/cache-live-control/keepwarm/sessions', undefined],
  [{ CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR: 'state/relative', XDG_STATE_HOME: '/state/xdg', HOME: '/state/user' }, '/state/xdg/cache-live-control/keepwarm/sessions', 'state directory: CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR not absolute; using /state/xdg/cache-live-control/keepwarm/sessions'],
  [{ CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR: 'state/relative', XDG_STATE_HOME: 'xdg', HOME: '/state/user' }, '/state/user/.local/state/cache-live-control/keepwarm/sessions', 'state directory: CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR, XDG_STATE_HOME not absolute; using /state/user/.local/state/cache-live-control/keepwarm/sessions'],
])('state transport resolves its directory and logs failures without breaking commands %#', async (env, directory, warning) => {
  const h = new Harness({}, env), destinations: string[] = [];
  (h.engine as any).process.run = async (argv: string[]) => { if (argv[0] !== 'node') return { exitCode: 0, stdout: '', stderr: '' }; destinations.push(argv[3]!); throw new Error('writer unavailable'); };
  await h.start();
  const result = await h.command('off');
  expect(result.text).toContain('off (session override)');
  expect(destinations.length).toBeGreaterThanOrEqual(2);
  expect(destinations.every(path => path === directory)).toBe(true);
  expect(h.debug.at(-1)).toContain(directory + '/session-1.json: Error: writer unavailable');
  expect(h.toasts).toEqual([]);
  expect((h.status ?? '').split(' · ').filter(part => part.startsWith('state directory'))).toEqual(warning ? [warning] : []);
});
