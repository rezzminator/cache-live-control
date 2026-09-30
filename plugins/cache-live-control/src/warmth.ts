import type { EnvSnapshot } from './status.ts';
import { isTtl, PARTIES, type Change, type Party, type Ttl } from './ttl.ts';

// Whether a party's prompt cache is still warm, and which `/cache` changes
// would switch a warm cache's TTL: the TTL lives in each request's
// cache_control, so the next request may write the whole prefix again
// (measured: usually it still reads it; see the README's warm-cache check).

/** A party's latest model request: when, and the TTL its variable held. */
export type StepRecord = { at: number; ttl: Ttl | 'automatic' };

export type Records = Partial<Record<Party, StepRecord>>;

const TTL_MS: Readonly<Record<Ttl, number>> = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

/** The TTL a request used, from its party's variable at that moment. */
export function recordedTtl(variable: string | undefined): Ttl | 'automatic' {
  return isTtl(variable) ? variable : 'automatic';
}

/**
 * The lifetime a record's cache has: automatic is 1h for the main chat (the
 * subscription default; the plugin cannot see the plan, so it assumes the
 * longer lifetime) and 5m for sub-agents (measured).
 */
export function effectiveTtl(party: Party, record: StepRecord): Ttl {
  if (record.ttl !== 'automatic') return record.ttl;
  return party === 'main' ? '1h' : '5m';
}

/** Milliseconds the party's cache stays warm, 0 when cold or never written. */
export function warmForMs(party: Party, record: StepRecord | undefined, now: number): number {
  if (record === undefined) return 0;
  return Math.max(0, record.at + TTL_MS[effectiveTtl(party, record)] - now);
}

/**
 * The value a party's variable holds after `/cache` sets it: `auto` on the
 * main chat returns to the launch's 1h when the plugin moved one there.
 */
export function variableAfter(party: Party, value: Ttl | null, launch1h: boolean): Ttl | undefined {
  if (value === null) return party === 'main' && launch1h ? '1h' : undefined;
  return value;
}

export type WarmChange = {
  party: Party;
  /** The TTL the warm cache was written at, as assumed for an automatic one. */
  ttl: Ttl;
  /** The cache was written with the variable unset (automatic). */
  automatic: boolean;
  /** The TTL is assumed (automatic main) or the target is automatic, so the rewrite only may happen. */
  may: boolean;
  /** What the variable becomes: a TTL, or `automatic` for unset. */
  target: Ttl | 'automatic';
  leftMs: number;
  agoMs: number;
};

/** The parties whose TTL the change alters while their cache is warm. */
export function warmChanges(change: Change, env: EnvSnapshot, records: Records, now: number, launch1h: boolean): WarmChange[] {
  const out: WarmChange[] = [];
  for (const party of PARTIES) {
    const value = change[party];
    if (value === undefined) continue;
    const record = records[party];
    const leftMs = warmForMs(party, record, now);
    if (record === undefined || leftMs === 0) continue;
    const next = variableAfter(party, value, launch1h);
    const current = env[party] === '' ? undefined : env[party];
    if (next === current) continue;
    const ttl = effectiveTtl(party, record);
    if (next !== undefined && next === ttl) continue;
    out.push({
      party,
      ttl,
      automatic: record.ttl === 'automatic',
      may: (record.ttl === 'automatic' && party === 'main') || next === undefined,
      target: next ?? 'automatic',
      leftMs,
      agoMs: now - record.at,
    });
  }
  return out;
}

function minutes(ms: number): string {
  const n = Math.ceil(ms / 60_000);
  return n === 1 ? '1 more minute' : `${n} more minutes`;
}

function ago(ms: number): string {
  const n = Math.floor(ms / 60_000);
  return n < 1 ? 'under a minute ago' : `${n}m ago`;
}

function possessive(party: Party): string {
  return party === 'agents' ? "agents'" : `${party}'s`;
}

function written(w: WarmChange): string {
  if (!w.automatic) return w.ttl;
  return `automatic, ${w.party === 'main' ? 'assumed ' : ''}${w.ttl}`;
}

/** The dialog's one-sentence question. */
export function warmQuestion(warm: readonly WarmChange[]): string {
  const may = warm.some((w) => w.may);
  const clauses = warm.map((w, i) =>
    i === 0
      ? `${possessive(w.party)} prompt cache ${may ? 'may be' : 'is'} warm for ${minutes(w.leftMs)} (${written(w)}, last request ${ago(w.agoMs)})`
      : `${possessive(w.party)} for ${minutes(w.leftMs)} (${written(w)}, last request ${ago(w.agoMs)})`,
  );
  const switches =
    warm.length === 1 ? `switching it to ${warm[0]!.target}` : `switching ${warm.map((w) => `${w.party} to ${w.target}`).join(' and ')}`;
  const rewrite = `may rewrite ${warm.length === 1 ? 'the whole cache' : 'both caches'} on the next request`;
  return `${clauses.join(' and ')}; ${switches} ${rewrite}. Switch anyway?`;
}

/** The line printed when the switch is declined, dismissed or cannot be asked. */
export function keptLine(warm: readonly WarmChange[], args: string): string {
  const clauses = warm.map((w, i) => (i === 0 ? `${possessive(w.party)} cache is warm for ${minutes(w.leftMs)}` : `${possessive(w.party)} for ${minutes(w.leftMs)}`));
  return `nothing changed: ${clauses.join(' and ')}; /cache ${args.trim()} force switches anyway`;
}

/** The status suffix for one party: `warm 41m`, `may be warm 41m` or `cold`. */
export function warmthLabel(party: Party, record: StepRecord | undefined, now: number): string {
  const left = warmForMs(party, record, now);
  if (record === undefined || left === 0) return 'cold';
  return `${record.ttl === 'automatic' && party === 'main' ? 'may be ' : ''}warm ${Math.ceil(left / 60_000)}m`;
}
