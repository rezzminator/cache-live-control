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
    expect(failed).toMatchObject({ count: 1, failed: 'env refused' });
    const next = wake(failed, { record: { at: NOW - 9 * MIN, ttl: '5m' } });
    expect(next.raise).toBe(true);
    expect(next.state.count).toBe(2);
  });
});

describe('markFired, markFailed', () => {
  it('records when it fired and clears an earlier failure', () => {
    const state = markFired(markFailed(newRaise(2), 'x'), NOW);
    expect(state).toMatchObject({ firedAt: NOW });
    expect(state.failed).toBeUndefined();
  });

  it('records the failure and leaves the count and firedAt alone', () => {
    const state = markFailed({ ...newRaise(2), count: 1 }, 'env refused');
    expect(state).toMatchObject({ count: 1, failed: 'env refused' });
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
    const fired = { ...markFired(counting, NOW), locked: true, failed: 'x' };
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
  const busy: RaiseState = { after: 2, count: 1, locked: true, firedAt: 5, weighed: 9, failed: 'x' };

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
});
