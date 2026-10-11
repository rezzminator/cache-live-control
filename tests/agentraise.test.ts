import { describe, expect, it } from 'vitest';
import {
  abandoned,
  agentRaiseStatus,
  dropAll,
  markReadOk,
  markFailed,
  markRaised,
  markRestored,
  newAgentRaise,
  onCommand,
  onLaunch,
  onRequest,
  onTurnComplete,
  rejoined,
  restorePlan,
  setAfter,
  setWaiting,
  sweep,
  type AgentRaiseState,
} from '../plugins/cache-live-control/src/agentraise.ts';
import type { EnvSnapshot, Ours } from '../plugins/cache-live-control/src/status.ts';

const MIN = 60_000;
const NOW = 1_000 * MIN;
const AUTO: EnvSnapshot = {};
const RAISED: EnvSnapshot = { agents: '1h' };
const MINE: Ours = { agents: { value: '1h', via: 'agent-raise' } };

function launch(state: AgentRaiseState, over: Partial<Parameters<typeof onLaunch>[1]> = {}) {
  return onLaunch(state, { id: 'a1', label: 'researcher', now: NOW, env: AUTO, ours: {}, ...over });
}

function request(state: AgentRaiseState, count: number, over: Partial<Parameters<typeof onRequest>[1]> = {}) {
  return onRequest(state, { id: 'a1', label: 'researcher', count, now: NOW, env: AUTO, ours: {}, ...over });
}

/** A state with one waiting holder whose 1h was written. */
function raised(extra: Partial<AgentRaiseState> = {}): AgentRaiseState {
  const { state } = launch(newAgentRaise({ waiting: true, after: 2 }));
  return { ...markRaised(state, NOW), ...extra };
}

describe('onLaunch: the predictive raise', () => {
  it('holds the agents at 1h for an agent that launches background work, and asks for the write once', () => {
    const out = launch(newAgentRaise({ waiting: true }));
    expect(out.raise).toBe(true);
    expect(out.state.holders).toEqual([{ id: 'a1', label: 'researcher', kind: 'waiting', since: NOW }]);
    expect(out.state.prior).toEqual({ value: undefined, ours: undefined });
  });

  it('asks for no write while the 1h is already written, and holds a second agent too', () => {
    const second = launch(raised(), { id: 'a2', label: 'builder', env: RAISED, ours: MINE });
    expect(second.raise).toBe(false);
    expect(second.state.holders.map((h) => h.id)).toEqual(['a1', 'a2']);
  });

  it('holds one agent once, refreshing when it last acted', () => {
    const again = launch(raised(), { now: NOW + 3 * MIN, env: RAISED, ours: MINE });
    expect(again.state.holders).toEqual([{ id: 'a1', label: 'researcher', kind: 'waiting', since: NOW + 3 * MIN }]);
    expect(again.raise).toBe(false);
  });

  it('keeps what the variable held before, to hand it back', () => {
    const ours: Ours = { agents: { value: '5m', via: 'option' } };
    expect(launch(newAgentRaise({ waiting: true }), { env: { agents: '5m' }, ours }).state.prior).toEqual({ value: '5m', ours: ours.agents });
  });

  it('does nothing when the option is off, /cache agents 5m was typed, FORCE_PROMPT_CACHING_5M is set, or the agents are already 1h', () => {
    const idle = (state: AgentRaiseState, over = {}) => {
      const out = launch(state, over);
      expect(out.raise).toBe(false);
      expect(out.state.holders).toEqual([]);
    };
    idle(newAgentRaise({ after: 2 }));
    idle({ ...newAgentRaise({ waiting: true }), locked: true });
    idle(newAgentRaise({ waiting: true }), { env: { force5m: '1' } });
    idle(newAgentRaise({ waiting: true }), { env: { agents: '1h' } });
    idle(newAgentRaise({ waiting: true }), { env: { enable1h: '1' } });
  });
});

describe('onRequest: the reactive raise', () => {
  it('raises at the Nth expired request of one agent and not before', () => {
    const state = newAgentRaise({ after: 2 });
    expect(request(state, 1)).toEqual({ state, raise: false });
    const out = request(state, 2);
    expect(out.raise).toBe(true);
    expect(out.state.holders).toEqual([{ id: 'a1', label: 'researcher', kind: 'sleeper', since: NOW }]);
  });

  it('is off without the option', () => {
    const state = newAgentRaise({ waiting: true });
    expect(request(state, 9)).toEqual({ state, raise: false });
  });

  it('upgrades a waiting holder to a sleeper, and a launch never downgrades it', () => {
    const upgraded = request(raised(), 2, { env: RAISED, ours: MINE });
    expect(upgraded.raise).toBe(false);
    expect(upgraded.state.holders).toEqual([{ id: 'a1', label: 'researcher', kind: 'sleeper', since: NOW }]);
    const again = launch(upgraded.state, { env: RAISED, ours: MINE });
    expect(again.state.holders[0]?.kind).toBe('sleeper');
  });

  it('refreshes a sleeper on each of its requests', () => {
    const first = request(newAgentRaise({ after: 1 }), 1).state;
    const later = request(markRaised(first, NOW), 4, { now: NOW + 20 * MIN, env: RAISED, ours: MINE });
    expect(later.raise).toBe(false);
    expect(later.state.holders).toEqual([{ id: 'a1', label: 'researcher', kind: 'sleeper', since: NOW + 20 * MIN }]);
  });

  it('is idle under the same conditions as the predictive raise', () => {
    expect(request({ ...newAgentRaise({ after: 1 }), locked: true }, 5).raise).toBe(false);
    expect(request(newAgentRaise({ after: 1 }), 5, { env: { force5m: '1' } }).raise).toBe(false);
    expect(request(newAgentRaise({ after: 1 }), 5, { env: { agents: '1h' } }).raise).toBe(false);
  });
});

describe('onTurnComplete, sweep: letting go', () => {
  it('releases a waiting holder when its turn ends, and asks to hand the variable back once none is left', () => {
    const out = onTurnComplete(raised(), { id: 'a1', terminal: false, now: NOW + MIN });
    expect(out.state.holders).toEqual([]);
    expect(out.restore).toBe(true);
  });

  it('keeps the variable while another agent holds it', () => {
    const two = launch(raised(), { id: 'a2', label: 'builder', env: RAISED, ours: MINE }).state;
    const out = onTurnComplete(two, { id: 'a1', terminal: false, now: NOW + MIN });
    expect(out.state.holders.map((h) => h.id)).toEqual(['a2']);
    expect(out.restore).toBe(false);
  });

  it('keeps a sleeper through a turn end while the agent lives, and releases it once it finished', () => {
    const sleeper = request(raised(), 2, { env: RAISED, ours: MINE }).state;
    const alive = onTurnComplete(sleeper, { id: 'a1', terminal: false, now: NOW + 2 * MIN });
    expect(alive.restore).toBe(false);
    expect(alive.state.holders).toEqual([{ id: 'a1', label: 'researcher', kind: 'sleeper', since: NOW + 2 * MIN }]);
    const done = onTurnComplete(sleeper, { id: 'a1', terminal: true, now: NOW + 2 * MIN });
    expect(done).toMatchObject({ restore: true, state: { holders: [] } });
  });

  it('ignores the end of a turn of an agent that holds nothing', () => {
    const state = raised();
    expect(onTurnComplete(state, { id: 'zz', terminal: true, now: NOW })).toEqual({ state, restore: false });
  });

  it('asks for no restore when the 1h was never written', () => {
    const { state } = launch(newAgentRaise({ waiting: true }));
    expect(onTurnComplete(state, { id: 'a1', terminal: false, now: NOW })).toMatchObject({ restore: false, state: { holders: [] } });
  });

  it('sweeps a holder idle for an hour, not one a minute short', () => {
    const state = raised();
    expect(sweep(state, NOW + 59 * MIN)).toEqual({ state, restore: false });
    const out = sweep(state, NOW + 60 * MIN);
    expect(out.state.holders).toEqual([]);
    expect(out.restore).toBe(true);
  });
});

describe('restorePlan, markRaised, markRestored, markFailed', () => {
  it('hands back what the variable held when it still holds our 1h', () => {
    const ours: Ours = { agents: { value: '5m', via: 'option' } };
    const { state } = launch(newAgentRaise({ waiting: true }), { env: { agents: '5m' }, ours });
    expect(restorePlan(markRaised(state, NOW), RAISED, MINE)).toEqual({ restore: true, value: '5m', ours: ours.agents });
    expect(restorePlan(raised(), RAISED, MINE)).toEqual({ restore: true, value: undefined, ours: undefined });
  });

  it('leaves the variable alone when something else changed it', () => {
    expect(restorePlan(raised(), { agents: '5m' }, { agents: { value: '5m', via: 'command' } })).toEqual({ restore: false });
    expect(restorePlan(raised(), RAISED, { agents: { value: '1h', via: 'command' } })).toEqual({ restore: false });
  });

  it('marks the write and the restore, and a failure stays until one works', () => {
    const { state } = launch(newAgentRaise({ waiting: true }));
    const failed = markFailed(state, 'env refused');
    expect(failed.failed).toBe('env refused');
    expect(failed.raisedAt).toBeUndefined();
    const ok = markRaised(failed, NOW);
    expect(ok.raisedAt).toBe(NOW);
    expect(ok.failed).toBeUndefined();
    const back = markRestored({ ...ok, holders: [] });
    expect(back.raisedAt).toBeUndefined();
    expect(back.prior).toBeUndefined();
  });
});

describe('a write in flight: what lands while the 1h or the hand-back is being written', () => {
  it('holds a second launch while the first raise is still writing, though the variable already reads 1h and is not yet credited', () => {
    const writing = launch(newAgentRaise({ waiting: true })).state;
    const second = launch(writing, { id: 'a2', label: 'builder', env: RAISED, ours: {} });
    expect(second.raise).toBe(false);
    expect(second.state.holders.map((h) => h.id)).toEqual(['a1', 'a2']);
  });

  it('keeps the prior when every holder lets go during the write, and the written 1h is then abandoned, to hand back', () => {
    const ours: Ours = { agents: { value: '5m', via: 'option' } };
    const writing = launch(newAgentRaise({ waiting: true }), { env: { agents: '5m' }, ours }).state;
    const gone = setWaiting(writing, false);
    expect(gone.restore).toBe(false);
    expect(gone.state.prior).toEqual({ value: '5m', ours: ours.agents });
    const landed = markRaised(gone.state, NOW);
    expect(abandoned(landed)).toBe(true);
    expect(restorePlan(landed, RAISED, MINE)).toEqual({ restore: true, value: '5m', ours: ours.agents });
    expect(abandoned(raised())).toBe(false);
    expect(abandoned(newAgentRaise({ waiting: true }))).toBe(false);
  });

  it('a holder that joined during the hand-back write asks for the 1h again, keeping what was handed back as the prior', () => {
    const joined = launch(raised({ holders: [] }), { id: 'a2', label: 'builder', env: { agents: '5m' }, ours: MINE }).state;
    const restored = { value: '5m', ours: { value: '5m' as const, via: 'option' as const } };
    const again = rejoined(markRestored(joined), restored);
    expect(again.raise).toBe(true);
    expect(again.state.prior).toEqual(restored);
    expect(again.state.holders.map((h) => h.id)).toEqual(['a2']);
    const none = rejoined(markRestored(raised({ holders: [] })), restored);
    expect(none.raise).toBe(false);
    expect(none.state.prior).toBeUndefined();
  });
});

describe('onCommand: a typed /cache agents outranks the raise', () => {
  it('lets go of every holder and forgets the prior; 5m locks the raise off, any other word unlocks', () => {
    const typed = onCommand(raised(), { agents: '5m' });
    expect(typed).toMatchObject({ holders: [], locked: true });
    expect(typed.raisedAt).toBeUndefined();
    expect(typed.prior).toBeUndefined();
    expect(onCommand({ ...raised(), locked: true }, { agents: '1h' }).locked).toBe(false);
    expect(onCommand({ ...raised(), locked: true }, { agents: null }).locked).toBe(false);
  });

  it('leaves the state alone for a change of main alone', () => {
    const state = raised();
    expect(onCommand(state, { main: '5m' })).toBe(state);
  });
});

describe('setWaiting, setAfter, dropAll: the live settings', () => {
  it('turning the predictive raise off drops the waiting holders, and asks to restore when none is left', () => {
    expect(setWaiting(raised(), false)).toMatchObject({ restore: true, state: { waiting: false, holders: [] } });
    expect(setWaiting(newAgentRaise(), true).state.waiting).toBe(true);
  });

  it('turning the reactive raise off drops the sleepers only', () => {
    const sleeper = request(raised(), 2, { env: RAISED, ours: MINE }).state;
    expect(setAfter(sleeper, undefined)).toMatchObject({ restore: true, state: { holders: [] } });
    const waiting = raised();
    const out = setAfter(waiting, undefined);
    expect(out.restore).toBe(false);
    expect(out.state.holders).toEqual(waiting.holders);
    expect('after' in out.state).toBe(false);
  });

  it('setting a count switches the reactive raise on and unlocks it', () => {
    const out = setAfter({ ...newAgentRaise(), locked: true }, 3);
    expect(out.state).toMatchObject({ after: 3, locked: false });
    expect(out.restore).toBe(false);
  });

  it('dropAll lets go of everything', () => {
    expect(dropAll(raised())).toMatchObject({ restore: true, state: { holders: [] } });
    expect(dropAll(newAgentRaise({ waiting: true }))).toMatchObject({ restore: false });
  });
});

describe('agentRaiseStatus', () => {
  const at = (state: AgentRaiseState, env: EnvSnapshot = AUTO, ours: Ours = {}, now = NOW) => agentRaiseStatus(state, env, ours, now);

  it('says off when neither option is set', () => {
    expect(at(newAgentRaise())).toBe('agent-raise off');
  });

  it('says what is ready', () => {
    expect(at(newAgentRaise({ waiting: true }))).toBe('agent-raise ready (waiting)');
    expect(at(newAgentRaise({ after: 3 }))).toBe('agent-raise ready (after 3 expiries)');
    expect(at(newAgentRaise({ waiting: true, after: 3 }))).toBe('agent-raise ready (waiting, after 3 expiries)');
  });

  it('names the agents it holds at 1h and since when', () => {
    const two = launch(raised(), { id: 'a2', label: 'builder', now: NOW + MIN, env: RAISED, ours: MINE }).state;
    expect(at(two, RAISED, MINE, NOW + 4 * MIN)).toBe('agent-raise holding agents at 1h for researcher, builder (since 4m ago)');
  });

  it('says why it does not act', () => {
    const state = newAgentRaise({ waiting: true });
    expect(at(state, { force5m: '1' })).toBe('agent-raise inactive: FORCE_PROMPT_CACHING_5M is set');
    expect(at({ ...state, locked: true })).toBe('agent-raise off: /cache agents 5m was typed this session');
    expect(at(state, { agents: '1h' })).toBe('agent-raise idle: agents is 1h');
  });

  it('shows a hand-back that failed after the raise was switched off: the variable may still be our 1h', () => {
    const off = setAfter(setWaiting(raised(), false).state, undefined).state;
    expect(at(markFailed(off, 'handing back failed'), RAISED, MINE)).toBe('agent-raise failed, the TTL may be unchanged: handing back failed');
    expect(at(markFailed(newAgentRaise(), 'stale'))).toBe('agent-raise off');
  });

  it('a read failure goes once a read works; a write failure stays until a write works', () => {
    const read = markFailed(newAgentRaise({ waiting: true }), 'clock refused', 'read');
    expect(at(read)).toBe('agent-raise failed, the TTL may be unchanged: clock refused');
    expect(at(markReadOk(read))).toBe('agent-raise ready (waiting)');
    const write = markFailed(newAgentRaise({ waiting: true }), 'env refused');
    expect(markReadOk(write)).toBe(write);
  });

  it('shows a failure, which claims no TTL', () => {
    expect(at(markFailed(newAgentRaise({ waiting: true }), 'env refused'))).toBe('agent-raise failed, the TTL may be unchanged: env refused');
  });
});
