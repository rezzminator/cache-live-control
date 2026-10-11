import { isForced5m, resolveParty, type EnvSnapshot, type Ours } from './status.ts';
import type { Change } from './ttl.ts';
import { effectiveTtl, warmForMs, type StepRecord } from './warmth.ts';

// The auto-raise (option raiseAfterExpiries): a main chat on a 5m cache that
// wakes to an expired one for the Nth time goes to 1h from that wake's own
// request on. The TTL is fixed per request in cache_control, so the decision
// is made before the request, from the timer alone: a main turn starting while
// its previous request, written at 5m, is 5m old or older.

export type RaiseState = {
  /** The option: expired wake-ups to count before main goes to 1h; absent when off. */
  after?: number;
  /** Expired wake-ups counted since the session began or the last `/cache main`. */
  count: number;
  /** `/cache main 5m` was typed this session: the raise never overrides it. */
  locked: boolean;
  /** When the raise wrote 1h. */
  firedAt?: number;
  /** The `at` of the request whose expiry was last counted: one wake counts once, whichever hook weighs it. */
  weighed?: number;
  /** A request at or before this time wrote another prefix (a compaction, another conversation): no expiry. */
  floor?: number;
  /** The last raise write failed, and why: shown by `/cache`, retried at the next expired wake. */
  failed?: string;
};

/** What the adapter knows when a main turn is about to send its first request. */
export type Wake = { record: StepRecord | undefined; now: number; env: EnvSnapshot; ours: Ours };

export function newRaise(after?: number): RaiseState {
  return after === undefined ? { count: 0, locked: false } : { after, count: 0, locked: false };
}

/** Counts this wake when it is an expired one; `raise` is true when it is the Nth. */
export function onWake(state: RaiseState, wake: Wake): { state: RaiseState; raise: boolean } {
  const idle = { state, raise: false };
  if (state.after === undefined || state.locked || state.firedAt !== undefined) return idle;
  if (isForced5m(wake.env.force5m)) return idle;
  if (resolveParty('main', wake.env, wake.ours).ttl !== '5m') return idle;
  const { record } = wake;
  if (record === undefined || record.at === state.weighed) return idle;
  if (state.floor !== undefined && record.at <= state.floor) return idle;
  if (effectiveTtl('main', record) !== '5m' || warmForMs('main', record, wake.now) > 0) return idle;
  const count = state.count + 1;
  return { state: { ...state, count, weighed: record.at }, raise: count >= state.after };
}

/** The raise wrote 1h. */
export function markFired(state: RaiseState, now: number): RaiseState {
  const { failed: _failed, ...rest } = state;
  return { ...rest, firedAt: now };
}

/** The raise's write failed: the count stays, so the next expired wake asks again. */
export function markFailed(state: RaiseState, reason: string): RaiseState {
  return { ...state, failed: reason };
}

/**
 * An explicit `/cache` change of main takes precedence: it resets the count,
 * and a `5m` switches the raise off for the session. A change of the agents
 * alone leaves it be.
 */
export function onCommand(state: RaiseState, change: Change): RaiseState {
  if (change.main === undefined) return state;
  const { firedAt: _firedAt, failed: _failed, ...rest } = state;
  return { ...rest, count: 0, locked: change.main === '5m' };
}

/** A compaction rewrote the prefix: the requests before it are no expiry to count. */
export function onBoundary(state: RaiseState, now: number): RaiseState {
  return { ...state, floor: now };
}

/**
 * A `/clear` or a resume starts a new conversation: the count starts over. The
 * variable outlives it, so a typed `/cache main 5m` and a raise that fired stand.
 */
export function onSessionEnd(state: RaiseState, now: number): RaiseState {
  const { weighed: _weighed, failed: _failed, ...rest } = state;
  return { ...rest, count: 0, floor: now };
}

function ago(ms: number): string {
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  return minutes < 120 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

/** The status segment `/cache` shows: off, counting k of N, fired when, or why it does not act. */
export function raiseStatus(state: RaiseState, env: EnvSnapshot, ours: Ours, now: number): string {
  if (state.after === undefined) return 'auto-raise off';
  if (isForced5m(env.force5m)) return 'auto-raise inactive: FORCE_PROMPT_CACHING_5M is set';
  if (state.failed !== undefined) return `auto-raise failed, the TTL may be unchanged: ${state.failed}`;
  if (state.firedAt !== undefined) return `auto-raise fired ${ago(Math.max(0, now - state.firedAt))}`;
  if (state.locked) return 'auto-raise off: /cache main 5m was typed this session';
  const main = resolveParty('main', env, ours);
  if (main.ttl !== '5m') return `auto-raise idle: main is ${main.ttl}`;
  return `auto-raise counting ${state.count} of ${state.after} expiries`;
}
