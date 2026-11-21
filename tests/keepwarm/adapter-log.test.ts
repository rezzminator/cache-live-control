import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './stand-in.ts';

const KEYS = ['ts', 'plugin', 'level', 'event', 'msg', 'where', 'session', 'detail'];
let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'kw-log-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const mode = (path: string) => statSync(path).mode & 0o777;
async function run(env: Record<string, string>) {
  const h = new Harness({}, env); h.realRun = true; await h.arm(); await h.advance(240000); await h.pokeReply(); return h;
}

test('PLUGIN_LOG_DIR wins over the plugin\'s own location variable and carries the file contract', async () => {
  const base = join(root, 'shared'), own = join(root, 'own');
  await run({ PLUGIN_LOG_DIR: base, CACHE_LIVE_CONTROL_KEEPWARM_LOG_DIR: own });
  const dir = join(base, 'cache-live-control'), text = readFileSync(join(dir, 'info.jsonl'), 'utf8');
  expect(existsSync(own)).toBe(false);
  expect(mode(dir)).toBe(0o700); expect(mode(join(dir, 'info.jsonl'))).toBe(0o600);
  const rows = read(dir, 'info.jsonl');
  expect(rows.some(r => r.event === 'poke')).toBe(true);
  for (const row of rows) { expect(Object.keys(row)).toEqual(KEYS); expect(row).toMatchObject({ plugin: 'keep-warm', level: 'info', session: 'session-1' }); }
  for (const line of text.split('\n').filter(Boolean)) expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(4096);
});

test('with PLUGIN_LOG_DIR unset the rows land in the home fallback', async () => {
  const home = join(root, 'home');
  await run({ HOME: home, CACHE_LIVE_CONTROL_KEEPWARM_LOG_DIR: join(root, 'own') });
  const dir = join(home, '.local', 'state', 'cache-live-control', 'logs');
  expect(read(dir, 'info.jsonl').length).toBeGreaterThan(0); expect(existsSync(join(root, 'own'))).toBe(false);
});

test('a failed poke is an error row in errors.jsonl', async () => {
  const base = join(root, 'shared'), h = new Harness({}, { PLUGIN_LOG_DIR: base }); h.realRun = true;
  h.submitImpl = async () => { throw new Error('submit down'); };
  await h.arm(); await h.advance(240000);
  const rows = read(join(base, 'cache-live-control'), 'errors.jsonl');
  expect(rows.length).toBeGreaterThan(0); expect(rows[0]).toMatchObject({ level: 'error', plugin: 'keep-warm' }); expect(Object.keys(rows[0])).toEqual(KEYS);
});

test('a level file past 20 MiB moves to .1 and a log-capped row goes to warnings.jsonl', async () => {
  const base = join(root, 'shared'), dir = join(base, 'cache-live-control');
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'info.jsonl'), ''); truncateSync(join(dir, 'info.jsonl'), 20971521);
  await run({ PLUGIN_LOG_DIR: base });
  expect(statSync(join(dir, 'info.jsonl.1')).size).toBe(20971521); expect(statSync(join(dir, 'info.jsonl')).size).toBeLessThan(20971521);
  expect(read(dir, 'warnings.jsonl')[0]).toMatchObject({ event: 'log-capped', level: 'warning', plugin: 'keep-warm' });
});

test('an unwritable log shows one line per failing streak and never a non-error row', async () => {
  const h = new Harness({}, { PLUGIN_LOG_DIR: join(root, 'shared') }); h.writeError = new Error('disk full');
  await h.arm(); await h.advance(240000); await h.pokeReply();
  expect(h.toasts.filter(t => t.includes('plugin log'))).toHaveLength(1);
  expect(h.toasts.every(t => !/step|poke|admit/.test(t))).toBe(true);
  expect(h.status).toContain('plugin log');
  h.writeError = null; await h.advance(1); await h.stop();
  h.writeError = new Error('disk full again'); await h.stop();
  expect(h.toasts.filter(t => t.includes('plugin log'))).toHaveLength(2);
});

test('with no directory resolvable logging is off, said once', async () => {
  const h = new Harness({}, { HOME: '' }); await h.arm(); await h.advance(240000);
  expect(h.toasts.filter(t => t.includes('plugin log'))).toHaveLength(1); expect(h.writes).toHaveLength(0); expect(h.submits).toHaveLength(1);
});
