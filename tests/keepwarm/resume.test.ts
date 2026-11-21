import { expect, test } from 'vitest';
import { restoreAnchor, snapshotSession, pickRestore, staleKeys, sessionKey, sessionPrefix, RESTORE_HORIZON_MS } from '../../plugins/cache-live-control/src/keepwarm/resume.ts';
function call<T>(fn: () => T): T | string { try { return fn(); } catch (error) { return String(error); } }
const ledger = { spent: 5, warms: 1, episodes: 0, estimatedNet: 0, unknown: 0 };
const anchor = { at: 100, context: 50000, tail: 2, model: 'claude-haiku-5-5', ttl: '5m' as const, ttlSource: 'env' as const };
const saved = { version: 1 as const, sessionId: 'session-1', savedAt: 150, anchor, ledger };
test.each([
  [undefined, { kind: 'absent' }], [null, { kind: 'rejected', reason: 'invalid-record' }],
  [saved, { kind: 'restored', anchor, ledger, savedAt: 150 }], [{ ...saved, anchor: null }, { kind: 'restored', anchor: null, ledger, savedAt: 150 }],
  [{ ...saved, sessionId: 'other' }, { kind: 'rejected', reason: 'session-mismatch' }],
  [{ ...saved, anchor: { ...anchor, at: 201 } }, { kind: 'rejected', reason: 'future-anchor' }],
  [{ ...saved, ledger: { ...ledger, spent: NaN } }, { kind: 'rejected', reason: 'invalid-record' }],
  [{ ...saved, anchor: { ...anchor, context: 0 } }, { kind: 'rejected', reason: 'invalid-record' }],
  [{ ...saved, anchor: { ...anchor, ttl: '1h', stray: '5m' } }, { kind: 'restored', anchor: { ...anchor, ttl: '1h' }, ledger, savedAt: 150 }],
  [{ ...saved, version: 2 }, { kind: 'rejected', reason: 'invalid-record' }],
  [{ ...saved, savedAt: NaN }, { kind: 'rejected', reason: 'invalid-record' }],
  [{ ...saved, savedAt: -1 }, { kind: 'rejected', reason: 'invalid-record' }],
  [{ version: 1, sessionId: 'session-1', anchor, ledger }, { kind: 'rejected', reason: 'invalid-record' }],
] as const)('restore %#', (value, expected) => expect(call(() => restoreAnchor(value, { sessionId: 'session-1', now: 200 }))).toEqual(expected));
test('snapshot allowlists numeric metadata and cannot restore a grant', () => {
  const actual = call(() => snapshotSession({ sessionId: 'session-1', savedAt: 150, anchor, ledger, enabled: true, tasks: ['secret'] } as Parameters<typeof snapshotSession>[0]));
  expect(actual).toEqual(saved);
});
test('each process instance owns its own key under one session prefix', () => {
  expect(call(() => sessionKey('a:b', 'f00d'))).toBe('session:a%3Ab:f00d');
  expect(call(() => sessionPrefix('a:b'))).toBe('session:a%3Ab:');
  expect(String(call(() => sessionKey('a:b', 'f00d'))).startsWith(String(call(() => sessionPrefix('a:b'))))).toBe(true);
});
test.each([
  [[], { kind: 'absent' }],
  [[saved, { ...saved, savedAt: 180, ledger: { ...ledger, warms: 4 } }], { kind: 'restored', anchor, ledger: { ...ledger, warms: 4 }, savedAt: 180 }],
  [[{ ...saved, savedAt: 180, ledger: { ...ledger, warms: 4 } }, saved], { kind: 'restored', anchor, ledger: { ...ledger, warms: 4 }, savedAt: 180 }],
  [[{ ...saved, sessionId: 'other' }, saved], { kind: 'restored', anchor, ledger, savedAt: 150 }],
  [[{ ...saved, sessionId: 'other' }, { ...saved, version: 2 }], { kind: 'rejected', reason: 'session-mismatch' }],
] as const)('newest valid actor restores %#', (values, expected) => expect(call(() => pickRestore(values, { sessionId: 'session-1', now: 200 }))).toEqual(expected));
test('snapshots past the horizon are pruned, readable or not; fresh ones, unaged ones and foreign keys stay', () => {
  const now = 10 * 86_400_000;
  const entries = [
    { key: 'session:session-1:a', value: { ...saved, savedAt: now - 1000, anchor: null } },
    { key: 'session:session-1:b', value: { ...saved, savedAt: now - RESTORE_HORIZON_MS - 1, anchor: null } },
    { key: 'session:session-2:c', value: { broken: true } },
    { key: 'session:session-2:d', value: { ...saved, version: 2, savedAt: now - 1000 } },
    { key: 'session:session-2:e', value: { ...saved, version: 2, savedAt: now - RESTORE_HORIZON_MS - 1 } },
    { key: 'session:session-2:f', value: { ...saved, savedAt: now - RESTORE_HORIZON_MS } },
    { key: 'other', value: { savedAt: 0 } },
  ];
  expect(call(() => staleKeys(entries, { now }))).toEqual(['session:session-1:b', 'session:session-2:e']);
});
