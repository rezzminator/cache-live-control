import type { Ttl } from './ttl.ts';
import { warmForMs } from './warmth.ts';

// One record per sub-agent: when its latest request went out, the TTL its
// variable held, and the size of its context. They feed the resume guard
// (a SendMessage to a cold, large agent), the reactive agent raise (how many
// of an agent's requests found its own cache expired) and the handoff (which
// spawn an agent came from).

export type AgentRecord = {
  /** When the agent's latest request went out. */
  at: number;
  /** The TTL the agents' variable held then. */
  ttl: Ttl | 'automatic';
  /** The prompt its latest response was answered over, plus the response: input + cache read + cache creation + output; 0 until known. */
  context: number;
  /** Requests that found this agent's own previous cache expired. */
  expired: number;
  /** Spawned but not yet seen requesting: `at` is the spawn, which wrote no cache. */
  pending?: true;
  /** The Agent tool call that started it. */
  spawn?: string;
  name?: string;
  parentId?: string;
};

export type AgentRecords = ReadonlyMap<string, AgentRecord>;

/** Records kept at most; the agent that asked longest ago goes first. */
export const AGENT_CAP = 256;

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

/** The context a response leaves the agent with, or undefined when it reported no usage. */
export function contextOf(usage: Usage | null | undefined): number | undefined {
  if (usage === null || usage === undefined) return undefined;
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens;
}

/**
 * An agent's request is going out at `step.at`. It is expired when the same
 * agent's previous request wrote a cache that is gone by now (any cause: a wake
 * after a background task, a slow tool, a resume); the first request after a
 * spawn has no previous cache.
 */
export function noteRequest(
  records: AgentRecords,
  id: string,
  step: { at: number; ttl: Ttl | 'automatic' },
): { records: AgentRecords; expired: boolean; count: number } {
  const before = records.get(id);
  const expired = before !== undefined && before.pending !== true && warmForMs('agents', before, step.at) === 0;
  const count = (before?.expired ?? 0) + (expired ? 1 : 0);
  const kept: Partial<AgentRecord> = { ...before };
  delete kept.pending;
  const next = new Map(records);
  next.set(id, { ...kept, at: step.at, ttl: step.ttl, context: before?.context ?? 0, expired: count });
  return { records: next, expired, count };
}

/** The context an agent's response left it with; an agent never seen is ignored. */
export function noteUsage(records: AgentRecords, id: string, context: number): AgentRecords {
  const before = records.get(id);
  if (before === undefined) return records;
  return new Map(records).set(id, { ...before, context });
}

/** An agent was spawned: its id, the spawn call, its name and its parent. */
export function noteSpawn(records: AgentRecords, id: string, info: { spawn: string; name?: string; parentId?: string; at: number }): AgentRecords {
  // The agent's first request may have gone out before the spawn returned its id.
  const before = records.get(id) ?? { at: info.at, ttl: 'automatic' as const, context: 0, expired: 0, pending: true as const };
  const next: AgentRecord = { ...before, spawn: info.spawn };
  if (info.name !== undefined) next.name = info.name;
  if (info.parentId !== undefined) next.parentId = info.parentId;
  return new Map(records).set(id, next);
}

/** Every expired count back to 0: a typed `/cache agents` starts the reactive count over. */
export function resetExpired(records: AgentRecords): AgentRecords {
  return new Map([...records].map(([id, record]) => [id, { ...record, expired: 0 }]));
}

/**
 * Forgets what nothing needs: an agent whose cache can no longer be warm goes
 * unless `keepCold` (the resume guard resumes cold agents, the reactive raise
 * counts their wakes); past `cap`, the agent that asked longest ago goes.
 */
export function prune(records: AgentRecords, now: number, keepCold: boolean, cap: number = AGENT_CAP): AgentRecords {
  let out = records;
  if (!keepCold) {
    const warm = [...records].filter(([, record]) => warmForMs('agents', record, now) > 0);
    if (warm.length !== records.size) out = new Map(warm);
  }
  if (out.size > cap) {
    const newest = [...out].sort(([, a], [, b]) => b.at - a.at).slice(0, cap);
    out = new Map(newest);
  }
  return out;
}

/** The agent's name, else its id. */
export function labelOf(records: AgentRecords, id: string): string {
  return records.get(id)?.name ?? id;
}
