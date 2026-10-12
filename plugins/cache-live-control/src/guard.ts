import type { AgentRecord, AgentRecords } from './agents.ts';
import { span } from './events.ts';
import { isForced5m, resolveParty, type EnvSnapshot, type Ours } from './status.ts';
import type { Ttl } from './ttl.ts';
import { effectiveTtl, warmForMs } from './warmth.ts';

// The cold-resume guard (option resumeGuard): a SendMessage to a sub-agent whose
// prompt cache has expired re-writes its whole context at the cache-write
// price, about as much as a fresh agent's whole run for a large context. A cold
// target above the floor is warned about or blocked, with the cost in tokens;
// the plugin owns no price table, so dollars show only when a price is set.

export type GuardMode = 'off' | 'warn' | 'block';

export type GuardConfig = {
  mode: GuardMode;
  /** Tokens: a smaller context is as cheap to resume as to spawn afresh, so it passes. */
  floor: number;
  /** USD per million base input tokens, when the user set one. */
  price?: number;
};

/** A message that begins with it is sent whatever the guard says, the marker removed. */
export const OVERRIDE = '[resume-anyway]';

export const DEFAULT_FLOOR = 60_000;

const LIFE_MS: Readonly<Record<Ttl, number>> = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

/** What a cache write costs relative to the base input price. */
export function multiplier(ttl: Ttl): number {
  return ttl === '1h' ? 2 : 1.25;
}

/** The agent a SendMessage recipient names: an id or a name, the records' or the listing's. */
export function resolveTarget(to: string, records: AgentRecords, listing: readonly { id: string; name?: string }[]): string | undefined {
  if (to === '') return undefined;
  if (records.has(to)) return to;
  let named: { id: string; at: number } | undefined;
  for (const [id, record] of records) {
    if (record.name === to && (named === undefined || record.at > named.at)) named = { id, at: record.at };
  }
  if (named !== undefined) return named.id;
  return (listing.find((agent) => agent.id === to) ?? listing.find((agent) => agent.name === to))?.id;
}

/** The message with the override marker removed, or undefined when it does not begin with one or is nothing but it. */
export function takeOverride(message: string): string | undefined {
  const marker = /^\s*\[resume-anyway\]\s*/i.exec(message);
  // A bare marker carries no message: no override.
  return marker === null || marker[0].length === message.length ? undefined : message.slice(marker[0].length);
}

export type GuardInput = GuardConfig & {
  /** The target's record; absent for an agent never seen. */
  record: AgentRecord | undefined;
  /** The name the text calls it. */
  label: string;
  now: number;
  /** The TTL the resume's request would write at: the agents' variable now. */
  rewriteTtl: Ttl;
};

export type Verdict = { kind: 'pass' } | { kind: 'warn' | 'block'; text: string };

/** A token count for a sentence: whole under a thousand, then rounded thousands. */
export function tokenText(n: number): string {
  return n < 1000 ? String(n) : `${Math.round(n / 1000)}k`;
}

/** The TTL a sub-agent's request would write its cache at now. */
export function rewriteTtl(env: EnvSnapshot, ours: Ours): Ttl {
  return !isForced5m(env.force5m) && resolveParty('agents', env, ours).ttl === '1h' ? '1h' : '5m';
}

/** Pass, warn or block one SendMessage to `label`. */
export function guardVerdict(input: GuardInput): Verdict {
  const { mode, floor, price, record, label, now, rewriteTtl } = input;
  if (mode === 'off' || record === undefined) return { kind: 'pass' };
  // A context of 0 was never measured: nothing to warn about.
  if (record.context === 0 || record.context < floor) return { kind: 'pass' };
  if (warmForMs('agents', record, now) > 0) return { kind: 'pass' };
  const ttl = effectiveTtl('agents', record);
  const idle = now - record.at;
  const mult = multiplier(rewriteTtl);
  const equivalent = Math.round(record.context * mult);
  const usd = price === undefined ? '' : ` ($${((equivalent * price) / 1_000_000).toFixed(2)} at $${price}/M base input)`;
  const body =
    `agent ${label} has been idle ${span(idle)} and its prompt cache expired ${span(idle - LIFE_MS[ttl])} ago (it was written at ${ttl}), ` +
    `so resuming re-writes its whole context: ~${tokenText(record.context)} tokens × ${mult} (a ${rewriteTtl} cache write) = ~${tokenText(equivalent)} input-token equivalents${usd}.`;
  const tail =
    mode === 'block'
      ? ` Not sent. To resume it anyway (for example it holds uncommitted work), send the same message beginning with ${OVERRIDE}.`
      : ' Sent anyway: resumeGuard is warn.';
  return { kind: mode, text: `${body}${tail}` };
}

function floorText(floor: number): string {
  return floor > 0 && floor % 1000 === 0 ? `${floor / 1000}k` : String(floor);
}

/** The status segment `/cache` shows. */
export function guardStatus(config: GuardConfig): string {
  if (config.mode === 'off') return 'resume-guard off';
  const price = config.price === undefined ? '' : `, $${config.price}/M`;
  return `resume-guard ${config.mode} (floor ${floorText(config.floor)}${price})`;
}
