import type { Ttl } from './ttl.ts';
import { warmForMs } from './warmth.ts';

// One record per sub-agent: when its latest request went out, the TTL its
// variable held, and the size of its context. They feed the resume guard
// (a SendMessage to a cold, large agent).

export type AgentRecord = {
  /** When the agent's latest request went out. */
  at: number;
  /** The TTL the agents' variable held then. */
  ttl: Ttl | 'automatic';
  /** The prompt its latest response was answered over, plus the response: input + cache read + cache creation + output; 0 until known. */
  context: number;
  /** Spawned but not yet seen requesting: `at` is the spawn, which wrote no cache. */
  pending?: true;
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

/** An agent's request is going out at `step.at` with the TTL its variable holds; the first one after a spawn ends its pending mark. */
export function noteRequest(records: AgentRecords, id: string, step: { at: number; ttl: Ttl | 'automatic' }): AgentRecords {
  const before = records.get(id);
  const kept: Partial<AgentRecord> = { ...before };
  delete kept.pending;
  return new Map(records).set(id, { ...kept, at: step.at, ttl: step.ttl, context: before?.context ?? 0 });
}

/** The context an agent's response left it with; an agent never seen is ignored. */
export function noteUsage(records: AgentRecords, id: string, context: number): AgentRecords {
  const before = records.get(id);
  if (before === undefined) return records;
  return new Map(records).set(id, { ...before, context });
}

/** An agent was spawned: its id, its name and its parent. */
export function noteSpawn(records: AgentRecords, id: string, info: { name?: string; parentId?: string; at: number }): AgentRecords {
  // The agent's first request may have gone out before the spawn returned its id.
  const before = records.get(id) ?? { at: info.at, ttl: 'automatic' as const, context: 0, pending: true as const };
  const next: AgentRecord = { ...before };
  if (info.name !== undefined) next.name = info.name;
  if (info.parentId !== undefined) next.parentId = info.parentId;
  return new Map(records).set(id, next);
}

/**
 * Forgets what nothing needs: an agent whose cache can no longer be warm goes
 * unless `keepCold` (the resume guard resumes cold agents); past `cap`, the agent that asked longest ago goes.
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
