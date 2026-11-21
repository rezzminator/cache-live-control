import type { Ttl, TtlSource } from './ttl.ts';
import type { SessionLedger } from './budget.ts';
export interface Anchor { at: number; context: number; tail: number; model: string; ttl: Ttl; ttlSource: TtlSource }
export interface SavedSession { version: 1; sessionId: string; savedAt: number; anchor: Anchor | null; ledger: SessionLedger }
export const RESTORE_HORIZON_MS = 7 * 86_400_000;
export type RestoreResult = { kind: 'absent' } | { kind: 'restored'; anchor: Anchor | null; ledger: SessionLedger; savedAt: number } | { kind: 'rejected'; reason: 'session-mismatch' | 'invalid-record' | 'future-anchor' };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function restoreAnchor(value: unknown, { sessionId, now }: { sessionId: string; now: number }): RestoreResult {
  if (value === undefined) return { kind: 'absent' };
  const reject = (reason: 'session-mismatch' | 'invalid-record' | 'future-anchor'): RestoreResult => ({ kind: 'rejected', reason });
  if (!record(value) || value.version !== 1 || typeof value.sessionId !== 'string' || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt < 0 || !record(value.ledger)) return reject('invalid-record');
  if (value.sessionId !== sessionId) return reject('session-mismatch');
  const l = value.ledger;
  if (!['spent', 'warms', 'episodes', 'estimatedNet', 'unknown'].every(k => typeof l[k] === 'number' && Number.isFinite(l[k])) || ['spent', 'warms', 'episodes', 'unknown'].some(k => Number(l[k]) < 0) || ['warms', 'episodes', 'unknown'].some(k => !Number.isSafeInteger(l[k]))) return reject('invalid-record');
  const a = value.anchor;
  if (a !== null) {
    if (!record(a) || !['at', 'context', 'tail'].every(k => typeof a[k] === 'number' && Number.isFinite(a[k]) && Number(a[k]) >= 0) || Number(a.context) <= 0 || typeof a.model !== 'string' || !a.model || !['5m', '1h'].includes(String(a.ttl)) || !['force-5m', 'env', 'observed', 'env-1h', 'assumed'].includes(String(a.ttlSource))) return reject('invalid-record');
    if (Number(a.at) > now) return reject('future-anchor');
  }
  const saved = snapshotSession({ sessionId, savedAt: value.savedAt, anchor: a as unknown as Anchor | null, ledger: l as unknown as SessionLedger });
  return { kind: 'restored', anchor: saved.anchor, ledger: saved.ledger, savedAt: saved.savedAt };
}
export function snapshotSession({ sessionId, savedAt, anchor, ledger }: { sessionId: string; savedAt: number; anchor: Anchor | null; ledger: SessionLedger }): SavedSession {
  return { version: 1, sessionId, savedAt, anchor: anchor ? { at: anchor.at, context: anchor.context, tail: anchor.tail, model: anchor.model, ttl: anchor.ttl, ttlSource: anchor.ttlSource } : null, ledger: { spent: ledger.spent, warms: ledger.warms, episodes: ledger.episodes, estimatedNet: ledger.estimatedNet, unknown: ledger.unknown } };
}
export function sessionPrefix(sessionId: string): string { return `session:${encodeURIComponent(sessionId)}:`; }
export function sessionKey(sessionId: string, instance: string): string { return sessionPrefix(sessionId) + instance; }
export function pickRestore(values: readonly unknown[], at: { sessionId: string; now: number }): RestoreResult {
  const results = values.map(value => restoreAnchor(value, at));
  const restored = results.filter((r): r is Extract<RestoreResult, { kind: 'restored' }> => r.kind === 'restored').sort((a, b) => b.savedAt - a.savedAt)[0];
  return restored ?? results.find(r => r.kind === 'rejected') ?? { kind: 'absent' };
}
/** Session records past the horizon, by their own `savedAt`, readable or not: a record this copy cannot restore (another version, a
 * damaged one) is kept until it ages out, and one without a usable `savedAt` is kept, never deleted unread. */
export function staleKeys(entries: readonly { key: string; value: unknown }[], { now }: { now: number }): string[] {
  return entries.filter(({ key, value }) => key.startsWith('session:') && record(value) && typeof value.savedAt === 'number' && value.savedAt < now - RESTORE_HORIZON_MS).map(({ key }) => key);
}
