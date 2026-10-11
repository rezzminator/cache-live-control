import { describe, expect, it } from 'vitest';
import {
  markFailed,
  markFired,
  newRaise,
  onBoundary,
  onCommand,
  onSessionEnd,
  onWake,
  raiseStatus,
  type RaiseState,
} from '../plugins/cache-live-control/src/raise.ts';
import type { EnvSnapshot, Ours } from '../plugins/cache-live-control/src/status.ts';

const MIN = 60_000;
const NOW = 1_000 * MIN;
const AT5 = { at: NOW - 6 * MIN, ttl: '5m' as const };
const ENV5: EnvSnapshot = { main: '5m' };
const MINE: Ours = { main: { value: '5m', via: 'option' } };

function wake(state: RaiseState, over: Partial<Parameters<typeof onWake>[1]> = {}) {
  return onWake(state, { record: AT5, now: NOW, env: ENV5, ours: MINE, ...over });
}

describe('onWake: which wake-ups count', () => {
  it('counts a main turn that starts after its 5m request is older than 5m, and raises only at the Nth', () => {
    const first = wake(newRaise(2));
    expect(first.raise).toBe(false);
    expect(first.state).toMatchObject({ after: 2, count: 1, weighed: AT5.at });
    const second = wake(first.state, { record: { at: NOW - 7 * MIN, ttl: '5m' } });
    expect(second.raise).toBe(true);
    expect(second.state).toMatchObject({ count: 2, weighed: NOW - 7 * MIN });
  });

  it('raises at the first expiry when N is 1', () => {
    expect(wake(newRaise(1)).raise).toBe(true);
  });

  it('counts a request exactly 5m old (the cache is gone at its TTL) and not one a millisecond younger', () => {
    expect(wake(newRaise(2), { record: { at: NOW - 5 * MIN, ttl: '5m' } }).state.count).toBe(1);
    expect(wake(newRaise(2), { record: { at: NOW - 5 * MIN + 1, ttl: '5m' } }).state.count).toBe(0);
  });

  it('counts one wake once, whichever hook weighs it', () => {
    const once = wake(newRaise(3)).state;
    const again = wake(once);
    expect(again.state.count).toBe(1);
    expect(again.raise).toBe(false);
  });

  it('counts nothing when the option is off', () => {
    const r = wake(newRaise());
    expect(r).toEqual({ state: newRaise(), raise: false });
  });

  it('counts nothing before the first request of the session', () => {
    expect(wake(newRaise(2), { record: undefined }).state.count).toBe(0);
  });

  it('counts only a previous request that ran at 5m: a 1h or automatic one outlives the wait', () => {
    expect(wake(newRaise(2), { record: { at: NOW - 6 * MIN, ttl: '1h' } }).state.count).toBe(0);
    expect(wake(newRaise(2), { record: { at: NOW - 6 * MIN, ttl: 'automatic' } }).state.count).toBe(0);
  });

  it('counts only while main runs at 5m now', () => {
    expect(wake(newRaise(2), { env: { main: '1h' }, ours: {} }).state.count).toBe(0);
    expect(wake(newRaise(2), { env: {}, ours: {} }).state.count).toBe(0);
    expect(wake(newRaise(2), { env: { main: '2h' }, ours: {} }).state.count).toBe(0);
    expect(wake(newRaise(2), { env: { enable1h: '1' }, ours: {} }).state.count).toBe(0);
  });

  it('never acts under FORCE_PROMPT_CACHING_5M', () => {
    expect(wake(newRaise(1), { env: { main: '5m', force5m: '1' } })).toEqual({ state: newRaise(1), raise: false });
    expect(wake(newRaise(1), { env: { main: '5m', force5m: '0' } }).raise).toBe(true);
  });

  it('never acts after a /cache main 5m, nor once fired', () => {
    const locked = { ...newRaise(1), locked: true };
    expect(wake(locked)).toEqual({ state: locked, raise: false });
    const fired = markFired(newRaise(1), NOW - MIN);
    expect(wake(fired)).toEqual({ state: fired, raise: false });
  });

  it('ignores a request older than the last compaction or session end: it belongs to another prefix', () => {
    const state = onBoundary(newRaise(2), NOW - 2 * MIN);
    expect(wake(state).state.count).toBe(0);
    expect(wake(state, { record: { at: NOW - 2 * MIN, ttl: '5m' } }).state.count).toBe(0);
    expect(wake(state, { record: { at: NOW - 2 * MIN + 1, ttl: '5m' }, now: NOW + 4 * MIN }).state.count).toBe(1);
  });

  it('asks again at the next expiry after a failed write, keeping the count', () => {
    const failed = markFailed(wake(newRaise(1)).state, 'env refused');
    expect(failed).toMatchObject({ count: 1, failed: { write: 'env refused' } });
    const next = wake(failed, { record: { at: NOW - 9 * MIN, ttl: '5m' } });
    expect(next.raise).toBe(true);
    expect(next.state.count).toBe(2);
  });
});

describe('a failure stands until what failed works again', () => {
  const read = markFailed({ ...newRaise(2), count: 1 }, 'env read refused', 'read');
  const compact = markFailed({ ...newRaise(2), count: 1 }, 'restarting the count failed: x', 'compact');
  const end = markFailed({ ...newRaise(2), count: 1 }, 'restarting the count failed: y', 'end');

  it('a wake whose read worked takes away a failed read, not a failed write or restart', () => {
    expect(wake(read, { record: undefined }).state.failed).toBeUndefined();
    expect(wake(markFailed(read, 'env refused'), { record: undefined }).state.failed).toEqual({ write: 'env refused' });
    expect(wake(compact, { record: undefined }).state.failed).toEqual({ compact: 'restarting the count failed: x' });
  });

  it('a later failure of another kind, and its recovery, leave the earlier one standing', () => {
    const write = markFailed({ ...newRaise(2), count: 2 }, 'env refused');
    const both = markFailed(write, 'env read refused', 'read');
    expect(both.failed).toEqual({ write: 'env refused', read: 'env read refused' });
    expect(wake(both, { record: undefined }).state.failed).toEqual({ write: 'env refused' });
    expect(wake(markFailed(compact, 'env read refused', 'read'), { record: undefined }).state.failed).toEqual({ compact: 'restarting the count failed: x' });
  });

  it('a compaction that worked takes away a failed compaction restart, not a failed read or session-end restart', () => {
    expect(onBoundary(compact, NOW).failed).toBeUndefined();
    expect(onBoundary(read, NOW).failed).toEqual({ read: 'env read refused' });
    expect(onBoundary(end, NOW).failed).toEqual({ end: 'restarting the count failed: y' });
  });

  it('a session end that worked starts everything over, its failures with it', () => {
    expect(onSessionEnd(end, NOW).failed).toBeUndefined();
    expect(onSessionEnd(markFailed(compact, 'env refused'), NOW).failed).toBeUndefined();
  });

  it('a /cache main takes away any failure with the count', () => {
    expect(onCommand(compact, { main: '1h' }).failed).toBeUndefined();
    expect(onCommand(markFailed(read, 'env refused'), { main: '5m' }).failed).toBeUndefined();
  });
});

describe('markFired, markFailed', () => {
  it('records when it fired and clears an earlier failure', () => {
    const state = markFired(markFailed(markFailed(newRaise(2), 'x'), 'y', 'read'), NOW);
    expect(state).toMatchObject({ firedAt: NOW });
    expect(state.failed).toBeUndefined();
  });

  it('records the failure and leaves the count and firedAt alone', () => {
    const state = markFailed({ ...newRaise(2), count: 1 }, 'env refused');
    expect(state).toMatchObject({ count: 1, failed: { write: 'env refused' } });
    expect(state.firedAt).toBeUndefined();
  });
});

describe('onCommand: an explicit /cache main takes precedence', () => {
  const counting = { ...newRaise(2), count: 1, weighed: 7 };

  it('resets the count on any change of main', () => {
    for (const main of ['1h', null] as const) {
      expect(onCommand(counting, { main })).toMatchObject({ after: 2, count: 0, locked: false, weighed: 7 });
    }
  });

  it('locks the raise out for a main 5m, alone or with the agents', () => {
    expect(onCommand(counting, { main: '5m' })).toMatchObject({ count: 0, locked: true });
    expect(onCommand(counting, { main: '5m', agents: '1h' })).toMatchObject({ count: 0, locked: true });
  });

  it('clears a fired raise and a failure, and a later non-5m command unlocks', () => {
    const fired = { ...markFired(counting, NOW), locked: true, failed: { end: 'x' } };
    const back = onCommand(fired, { main: '1h' });
    expect(back.firedAt).toBeUndefined();
    expect(back.failed).toBeUndefined();
    expect(back.locked).toBe(false);
  });

  it('leaves the state alone for a change of the agents only', () => {
    const locked = { ...counting, locked: true };
    expect(onCommand(locked, { agents: '1h' })).toEqual(locked);
    expect(onCommand(locked, {})).toEqual(locked);
  });
});

describe('onBoundary, onSessionEnd', () => {
  const busy: RaiseState = { after: 2, count: 1, locked: true, firedAt: 5, weighed: 9, failed: { write: 'x' } };

  it('a compaction only moves the floor', () => {
    expect(onBoundary(busy, NOW)).toEqual({ ...busy, floor: NOW });
  });

  it('a session end starts the count over but keeps the lock and the fire: the variable outlives it', () => {
    expect(onSessionEnd(busy, NOW)).toEqual({ after: 2, count: 0, locked: true, firedAt: 5, floor: NOW });
  });
});

describe('raiseStatus', () => {
  const at = (state: RaiseState, env = ENV5, ours: Ours = MINE) => raiseStatus(state, env, ours, NOW);

  it('is off without the option', () => {
    expect(at(newRaise())).toBe('auto-raise off');
  });

  it('counts: k of N expiries', () => {
    expect(at(newRaise(2))).toBe('auto-raise counting 0 of 2 expiries');
    expect(at({ ...newRaise(2), count: 1 })).toBe('auto-raise counting 1 of 2 expiries');
  });

  it('names when it fired', () => {
    expect(at(markFired(newRaise(2), NOW - 12 * MIN), { main: '1h' }, { main: { value: '1h', via: 'raise' } })).toBe('auto-raise fired 12m ago');
    expect(at(markFired(newRaise(2), NOW - 10_000), { main: '1h' })).toBe('auto-raise fired just now');
    expect(at(markFired(newRaise(2), NOW - 3 * 60 * MIN), { main: '1h' })).toBe('auto-raise fired 3h ago');
  });

  it('says a /cache main 5m switched it off for the session', () => {
    expect(at({ ...newRaise(2), locked: true })).toBe('auto-raise off: /cache main 5m was typed this session');
  });

  it('says FORCE_PROMPT_CACHING_5M makes it inactive, over everything else', () => {
    expect(at(newRaise(2), { main: '5m', force5m: '1' })).toBe('auto-raise inactive: FORCE_PROMPT_CACHING_5M is set');
    expect(at(markFired(newRaise(2), NOW), { main: '1h', force5m: 'yes' })).toBe('auto-raise inactive: FORCE_PROMPT_CACHING_5M is set');
  });

  it('says it is idle while main is not on 5m', () => {
    expect(at(newRaise(2), { main: '1h' }, {})).toBe('auto-raise idle: main is 1h');
    expect(at(newRaise(2), {}, {})).toBe('auto-raise idle: main is automatic');
  });

  it('prints the failed write in the existing style, and never claims it fired', () => {
    expect(at(markFailed({ ...newRaise(2), count: 2 }, 'env refused'))).toBe('auto-raise failed, the TTL may be unchanged: env refused');
  });

  it('names every failure left, and a count restart alone claims no TTL doubt', () => {
    const write = markFailed({ ...newRaise(2), count: 2 }, 'env refused');
    expect(at(markFailed(write, 'restarting the count failed: x', 'compact'))).toBe('auto-raise failed, the TTL may be unchanged: env refused; restarting the count failed: x');
    expect(at(markFailed(newRaise(2), 'restarting the count failed: x', 'end'))).toBe('auto-raise failed: restarting the count failed: x');
  });

  it('a count restart that failed after it fired or was switched off hides neither', () => {
    const late = (state: RaiseState) => markFailed(state, 'restarting the count failed: x', 'end');
    expect(at(late(markFired(newRaise(2), NOW - 3 * MIN)), { main: '1h' })).toBe('auto-raise fired 3m ago');
    expect(at(late({ ...newRaise(2), locked: true }))).toBe('auto-raise off: /cache main 5m was typed this session');
  });
});

import { setAfter } from '../plugins/cache-live-control/src/raise.ts';

describe('setAfter: /cache raise N|off', () => {
  it('starts a fresh count at the new threshold, unlocked and unfired, keeping the compaction floor and the weighed request', () => {
    const before: RaiseState = { after: 2, count: 1, locked: true, firedAt: 5, weighed: 9, floor: 4, failed: { write: 'x' } };
    expect(setAfter(before, 3)).toEqual({ after: 3, count: 0, locked: false, weighed: 9, floor: 4 });
  });

  it('switches the raise off, leaving the rest', () => {
    const out = setAfter({ after: 2, count: 1, locked: false, weighed: 9 }, undefined);
    expect(out).toEqual({ count: 0, locked: false, weighed: 9 });
    expect('after' in out).toBe(false);
  });

  it('turns a raise that was off on', () => {
    expect(setAfter(newRaise(), 2)).toEqual({ after: 2, count: 0, locked: false });
  });
});
