import { ago } from './events.ts';
import { isForced5m, resolveParty, type EnvSnapshot, type Ours } from './status.ts';
import type { Change } from './ttl.ts';

// The agents' auto-raise: CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL is one variable
// for the whole process, and a write reaches every sub-agent request built
// while it holds (measured: an agent raised alone for its own requests left
// five of nine requests of other agents at 1h). So no agent is raised alone:
// the variable is held at 1h for every sub-agent for as long as an agent that
// needs it is alive, and handed back after. Two triggers, each its own option:
//  - agentRaiseWaiting: an agent that launches background work (a background
//    sub-agent or a background shell) will end its turn and wait; its
//    turn-ending request is written at 1h, so the wake reads it. Released at
//    that turn's end.
//  - agentRaiseAfterExpiries: an agent that found its own cache expired N times
//    stays held (a sleeper) until it finished or has been idle for an hour.
// The main chat's variable is never touched; a typed `/cache agents` outranks it.

const HOUR = 60 * 60_000;

export type Holder = {
  id: string;
  label: string;
  /** `waiting` is released at its turn's end; a `sleeper` when the agent has finished. */
  kind: 'waiting' | 'sleeper';
  /** When it last acted: a holder idle for an hour is swept. */
  since: number;
};

export type AgentRaiseState = {
  /** agentRaiseWaiting. */
  waiting: boolean;
  /** agentRaiseAfterExpiries; absent when off. */
  after?: number;
  /** `/cache agents 5m` was typed this session: the raise never overrides it. */
  locked: boolean;
  holders: readonly Holder[];
  /** What the variable and our record of it held before the raise wrote 1h, to hand back. */
  prior?: { value: string | undefined; ours: Ours['agents'] };
  /** When the 1h was written; absent while the variable is not ours. */
  raisedAt?: number;
  /** The 1h write is in flight: a launch meanwhile joins it, and a release keeps the prior for it. */
  raising?: true;
  /** Why the last write, restore or read failed, until one works. */
  failed?: string;
  /** A `read` failure goes at the next read that works; a `write` one at the next write. */
  failedKind?: 'read' | 'write';
};

export function newAgentRaise(options: { waiting?: boolean; after?: number } = {}): AgentRaiseState {
  const state: AgentRaiseState = { waiting: options.waiting === true, locked: false, holders: [] };
  if (options.after !== undefined) state.after = options.after;
  return state;
}

type Ctx = { now: number; env: EnvSnapshot; ours: Ours };

/** The raise may hold the variable: not locked off, not forced to 5m, and the agents are at 5m or automatic (or already at our 1h). */
function acts(state: AgentRaiseState, env: EnvSnapshot, ours: Ours): boolean {
  if (state.locked || isForced5m(env.force5m)) return false;
  // Our own 1h write is in flight: the variable may already read 1h before it is credited ours.
  if (state.raising) return true;
  if (state.raisedAt !== undefined && env.agents === '1h' && ours.agents?.via === 'agent-raise') return true;
  const ttl = resolveParty('agents', env, ours).ttl;
  return ttl === '5m' || ttl === 'automatic';
}

function hold(state: AgentRaiseState, a: Ctx & { id: string; label: string }, kind: Holder['kind']): { state: AgentRaiseState; raise: boolean } {
  if (!acts(state, a.env, a.ours)) return { state, raise: false };
  const old = state.holders.find((h) => h.id === a.id);
  const holder: Holder = { id: a.id, label: a.label, kind: old?.kind === 'sleeper' ? 'sleeper' : kind, since: a.now };
  const holders = old === undefined ? [...state.holders, holder] : state.holders.map((h) => (h.id === a.id ? holder : h));
  const raise = state.raisedAt === undefined && state.raising !== true;
  const prior = raise ? { prior: { value: a.env.agents === '' ? undefined : a.env.agents, ours: a.ours.agents }, raising: true as const } : {};
  return { state: { ...state, ...prior, holders }, raise };
}

/** An agent launched background work: it will end its turn and wait. `raise` is true when the variable is to be written 1h now. */
export function onLaunch(state: AgentRaiseState, a: Ctx & { id: string; label: string }): { state: AgentRaiseState; raise: boolean } {
  if (!state.waiting) return { state, raise: false };
  return hold(state, a, 'waiting');
}

/** An agent's request found its own cache expired, `count` times in all. */
export function onRequest(state: AgentRaiseState, a: Ctx & { id: string; label: string; count: number }): { state: AgentRaiseState; raise: boolean } {
  if (state.after === undefined || a.count < state.after) return { state, raise: false };
  return hold(state, a, 'sleeper');
}

function release(state: AgentRaiseState, holders: readonly Holder[]): { state: AgentRaiseState; restore: boolean } {
  if (holders.length === state.holders.length) return { state, restore: false };
  if (holders.length > 0) return { state: { ...state, holders }, restore: false };
  if (state.raisedAt !== undefined) return { state: { ...state, holders }, restore: true };
  // The 1h is still being written: its prior stays, so the write, once it lands, can be handed back (abandoned).
  if (state.raising) return { state: { ...state, holders }, restore: false };
  const { prior: _prior, ...rest } = state;
  return { state: { ...rest, holders }, restore: false };
}

/** An agent's turn ended: a waiting holder is released, a sleeper only once the agent has finished. */
export function onTurnComplete(state: AgentRaiseState, a: { id: string; terminal: boolean; now: number }): { state: AgentRaiseState; restore: boolean } {
  const holder = state.holders.find((h) => h.id === a.id);
  if (holder === undefined) return { state, restore: false };
  if (holder.kind === 'sleeper' && !a.terminal) {
    return { state: { ...state, holders: state.holders.map((h) => (h.id === a.id ? { ...h, since: a.now } : h)) }, restore: false };
  }
  return release(state, state.holders.filter((h) => h.id !== a.id));
}

/** Holders idle for an hour are released: their cache is gone either way. */
export function sweep(state: AgentRaiseState, now: number): { state: AgentRaiseState; restore: boolean } {
  return release(state, state.holders.filter((h) => now - h.since < HOUR));
}

export function markRaised(state: AgentRaiseState, now: number): AgentRaiseState {
  const { failed: _failed, failedKind: _kind, raising: _raising, ...rest } = state;
  return { ...rest, raisedAt: now };
}

/** The 1h landed after every holder had let go: it is to be handed back at once. */
export function abandoned(state: AgentRaiseState): boolean {
  return state.raisedAt !== undefined && state.holders.length === 0;
}

export function markRestored(state: AgentRaiseState): AgentRaiseState {
  const { failed: _failed, failedKind: _kind, prior: _prior, raisedAt: _raisedAt, raising: _raising, ...rest } = state;
  return rest;
}

/**
 * After a hand-back: an agent that launched while the hand-back was being
 * written joined a raise that was ending. The 1h is asked for again, and what
 * was just handed back is the prior to restore after it.
 */
export function rejoined(state: AgentRaiseState, restored: NonNullable<AgentRaiseState['prior']>): { state: AgentRaiseState; raise: boolean } {
  if (state.holders.length === 0 || state.raisedAt !== undefined || state.raising) return { state, raise: false };
  return { state: { ...state, prior: restored, raising: true }, raise: true };
}

/**
 * A write, a restore or a read failed: the TTL may be unchanged, and the next
 * event asks again. A failed write ends the raise's write in flight; a failed
 * read leaves another agent's write in flight alone.
 */
export function markFailed(state: AgentRaiseState, reason: string, kind: 'read' | 'write' = 'write'): AgentRaiseState {
  if (kind === 'read') return { ...state, failed: reason, failedKind: kind };
  const { raising: _raising, ...rest } = state;
  return { ...rest, failed: reason, failedKind: kind };
}

/** A read worked: a read failure shown before goes; a write failure stays. */
export function markReadOk(state: AgentRaiseState): AgentRaiseState {
  if (state.failedKind !== 'read') return state;
  const { failed: _failed, failedKind: _kind, ...rest } = state;
  return rest;
}

/** Hands the variable back only while it still holds our 1h; anything else changed it and stands. */
export function restorePlan(
  state: AgentRaiseState,
  env: EnvSnapshot,
  ours: Ours,
): { restore: false } | { restore: true; value: string | undefined; ours: Ours['agents'] } {
  const mine = ours.agents;
  if (state.raisedAt === undefined || state.prior === undefined || env.agents !== '1h' || mine?.value !== '1h' || mine.via !== 'agent-raise') {
    return { restore: false };
  }
  return { restore: true, value: state.prior.value, ours: state.prior.ours };
}

/** A typed `/cache agents …` outranks the raise: it lets go of every holder, and `5m` switches the raise off for the session. */
export function onCommand(state: AgentRaiseState, change: Change): AgentRaiseState {
  if (change.agents === undefined) return state;
  const { prior: _prior, raisedAt: _raisedAt, failed: _failed, failedKind: _kind, raising: _raising, ...rest } = state;
  return { ...rest, holders: [], locked: change.agents === '5m' };
}

function dropKind(state: AgentRaiseState, kind: Holder['kind']): { state: AgentRaiseState; restore: boolean } {
  return release(state, state.holders.filter((h) => h.kind !== kind));
}

/** `/cache agents waiting on|off`. */
export function setWaiting(state: AgentRaiseState, on: boolean): { state: AgentRaiseState; restore: boolean } {
  if (on) return { state: { ...state, waiting: true, locked: false }, restore: false };
  return dropKind({ ...state, waiting: false }, 'waiting');
}

/** `/cache agents raise N|off`. */
export function setAfter(state: AgentRaiseState, after: number | undefined): { state: AgentRaiseState; restore: boolean } {
  if (after !== undefined) return { state: { ...state, after, locked: false }, restore: false };
  const { after: _after, ...rest } = state;
  return dropKind(rest, 'sleeper');
}

/** Lets go of every holder: a new conversation. */
export function dropAll(state: AgentRaiseState): { state: AgentRaiseState; restore: boolean } {
  return release(state, []);
}

function options(state: AgentRaiseState): string {
  return [state.waiting ? 'waiting' : undefined, state.after === undefined ? undefined : `after ${state.after} expiries`].filter((part) => part !== undefined).join(', ');
}

/** The status segment `/cache` shows. */
export function agentRaiseStatus(state: AgentRaiseState, env: EnvSnapshot, ours: Ours, now: number): string {
  // Switched off with a hand-back that failed: the variable may still hold our 1h, so the failure shows.
  if (!state.waiting && state.after === undefined) {
    return state.failed !== undefined && state.raisedAt !== undefined ? `agent-raise failed, the TTL may be unchanged: ${state.failed}` : 'agent-raise off';
  }
  if (isForced5m(env.force5m)) return 'agent-raise inactive: FORCE_PROMPT_CACHING_5M is set';
  if (state.locked) return 'agent-raise off: /cache agents 5m was typed this session';
  if (state.failed !== undefined) return `agent-raise failed, the TTL may be unchanged: ${state.failed}`;
  if (state.holders.length > 0 && state.raisedAt !== undefined) {
    return `agent-raise holding agents at 1h for ${state.holders.map((h) => h.label).join(', ')} (since ${ago(Math.max(0, now - state.raisedAt))})`;
  }
  const agents = resolveParty('agents', env, ours).ttl;
  if (agents !== '5m' && agents !== 'automatic') return `agent-raise idle: agents is ${agents}`;
  return `agent-raise ready (${options(state)})`;
}
