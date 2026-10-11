import { isForced5m, resolveParty, type EnvSnapshot, type Ours } from './status.ts';
import type { Change } from './ttl.ts';
import { ago } from './events.ts';
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
  /**
   * What failed, and why, one entry per kind: shown by `/cache` until that kind
   * works again, so one kind's failure or recovery never hides another's.
   */
  failed?: Failures;
};

/**
 * The raise's write (retried at the next expired wake), a read of the clock or
 * the environment, the count's restart after a compaction, or after a `/clear`
 * or a resume.
 */
export type FailureKind = 'write' | 'read' | 'compact' | 'end';
export type Failures = Partial<Record<FailureKind, string>>;

/** `state` without its failures of `kinds`; the others stand. */
function clearFailure(state: RaiseState, ...kinds: FailureKind[]): RaiseState {
  const { failed, ...rest } = state;
  if (failed === undefined) return state;
  const left: Failures = { ...failed };
  for (const kind of kinds) delete left[kind];
  return Object.keys(left).length === 0 ? rest : { ...rest, failed: left };
}

/** What the adapter knows when a main turn is about to send its first request. */
export type Wake = { record: StepRecord | undefined; now: number; env: EnvSnapshot; ours: Ours };

export function newRaise(after?: number): RaiseState {
  return after === undefined ? { count: 0, locked: false } : { after, count: 0, locked: false };
}

/** Counts this wake when it is an expired one; `raise` is true when it is the Nth. */
export function onWake(before: RaiseState, wake: Wake): { state: RaiseState; raise: boolean } {
  // The read that built `wake` worked: a failed read is over.
  const state = clearFailure(before, 'read');
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

/** Something failed: the count stays, and after a failed write the next expired wake asks again. */
export function markFailed(state: RaiseState, reason: string, kind: FailureKind = 'write'): RaiseState {
  return { ...state, failed: { ...state.failed, [kind]: reason } };
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
  return { ...clearFailure(state, 'compact'), floor: now };
}

/**
 * A `/clear` or a resume starts a new conversation: the count starts over. The
 * variable outlives it, so a typed `/cache main 5m` and a raise that fired stand.
 */
export function onSessionEnd(state: RaiseState, now: number): RaiseState {
  const { weighed: _weighed, failed: _failed, ...rest } = state;
  return { ...rest, count: 0, floor: now };
}

/**
 * The status segment `/cache` shows: off, counting k of N, fired when, failed
 * why, or why it does not act. Once it fired or was switched off, a failure
 * left (a count restart's) changes nothing it does, so it is not shown.
 */
export function raiseStatus(state: RaiseState, env: EnvSnapshot, ours: Ours, now: number): string {
  if (state.after === undefined) return 'auto-raise off';
  if (isForced5m(env.force5m)) return 'auto-raise inactive: FORCE_PROMPT_CACHING_5M is set';
  if (state.firedAt !== undefined) return `auto-raise fired ${ago(Math.max(0, now - state.firedAt))}`;
  if (state.locked) return 'auto-raise off: /cache main 5m was typed this session';
  const failed = state.failed ?? {};
  const ttl = [failed.write, failed.read].filter((reason) => reason !== undefined);
  const restart = [failed.compact, failed.end].filter((reason) => reason !== undefined);
  if (ttl.length > 0) return `auto-raise failed, the TTL may be unchanged: ${[...ttl, ...restart].join('; ')}`;
  // A count restart never touches the TTL: its failure claims no TTL doubt.
  if (restart.length > 0) return `auto-raise failed: ${restart.join('; ')}`;
  const main = resolveParty('main', env, ours);
  if (main.ttl !== '5m') return `auto-raise idle: main is ${main.ttl}`;
  return `auto-raise counting ${state.count} of ${state.after} expiries`;
}

/**
 * `/cache raise N|off`: a new threshold starts a fresh count and unlocks the
 * raise; the compaction floor and the weighed request stay, since they say which
 * requests already count.
 */
export function setAfter(state: RaiseState, after: number | undefined): RaiseState {
  const { firedAt: _firedAt, failed: _failed, after: _after, count: _count, locked: _locked, ...rest } = state;
  return after === undefined ? { ...rest, count: 0, locked: false } : { ...rest, after, count: 0, locked: false };
}
