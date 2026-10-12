import { describe, expect, it } from 'vitest';
import {
  contextOf,
  labelOf,
  noteRequest,
  noteSpawn,
  noteUsage,
  prune,
  type AgentRecord,
  type AgentRecords,
} from '../plugins/cache-live-control/src/agents.ts';

const MIN = 60_000;
const NOW = 1_000 * MIN;
const EMPTY: AgentRecords = new Map();

function records(entries: Record<string, AgentRecord>): AgentRecords {
  return new Map(Object.entries(entries));
}

describe('contextOf', () => {
  it('is input + cache read + cache creation + output, the prompt the next request carries', () => {
    expect(contextOf({ input_tokens: 3, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000 })).toBe(102_503);
  });

  it('is unknown when the request reported no usage', () => {
    expect(contextOf(null)).toBeUndefined();
    expect(contextOf(undefined)).toBeUndefined();
  });
});

describe('noteRequest', () => {
  it('records the first request of an agent', () => {
    const out = noteRequest(EMPTY, 'a1', { at: NOW, ttl: 'automatic' });
    expect(out.get('a1')).toEqual({ at: NOW, ttl: 'automatic', context: 0 });
  });

  it('moves the agent\'s record to the new request and keeps its context', () => {
    const before = records({ a1: { at: NOW - 5 * MIN, ttl: 'automatic', context: 90_000 } });
    const out = noteRequest(before, 'a1', { at: NOW, ttl: '5m' });
    expect(out.get('a1')).toEqual({ at: NOW, ttl: '5m', context: 90_000 });
    expect(before.get('a1')?.at).toBe(NOW - 5 * MIN);
  });

  it('keeps the name and parent noted at spawn, and never changes its input', () => {
    const spawned = noteSpawn(EMPTY, 'a1', { name: 'researcher', parentId: 'p1', at: NOW - MIN });
    const out = noteRequest(spawned, 'a1', { at: NOW, ttl: '5m' });
    expect(out.get('a1')).toEqual({ at: NOW, ttl: '5m', context: 0, name: 'researcher', parentId: 'p1' });
    expect(spawned.get('a1')?.at).toBe(NOW - MIN);
  });
});

describe('noteUsage, noteSpawn, labelOf', () => {
  it('sets the context of a known agent and ignores an unknown one', () => {
    const before = records({ a1: { at: NOW, ttl: '5m', context: 0 } });
    expect(noteUsage(before, 'a1', 187_000).get('a1')?.context).toBe(187_000);
    expect(noteUsage(before, 'zz', 5)).toBe(before);
  });

  it('notes a spawn: the agent id, its name and parent', () => {
    expect(noteSpawn(EMPTY, 'a1', { name: 'researcher', parentId: 'p1', at: NOW }).get('a1')).toEqual({
      at: NOW,
      ttl: 'automatic',
      context: 0,
      pending: true,
      name: 'researcher',
      parentId: 'p1',
    });
  });

  it('clears the pending mark at the first request after a spawn', () => {
    const spawned = noteSpawn(EMPTY, 'a1', { at: NOW - 30 * MIN });
    expect(spawned.get('a1')).toHaveProperty('pending', true);
    expect(noteRequest(spawned, 'a1', { at: NOW, ttl: '5m' }).get('a1')).not.toHaveProperty('pending');
  });

  it('labels an agent by its name, else its id', () => {
    const r = records({ a1: { at: NOW, ttl: '5m', context: 0, name: 'researcher' }, a2: { at: NOW, ttl: '5m', context: 0 } });
    expect(labelOf(r, 'a1')).toBe('researcher');
    expect(labelOf(r, 'a2')).toBe('a2');
    expect(labelOf(r, 'unknown')).toBe('unknown');
  });
});

describe('prune', () => {
  const warm: AgentRecord = { at: NOW - MIN, ttl: 'automatic', context: 1 };
  const cold: AgentRecord = { at: NOW - 30 * MIN, ttl: 'automatic', context: 1 };

  it('forgets an agent whose cache can no longer be warm when nothing needs it', () => {
    const out = prune(records({ warm, cold }), NOW, false);
    expect([...out.keys()]).toEqual(['warm']);
  });

  it('keeps a cold agent while the resume guard needs it', () => {
    expect([...prune(records({ warm, cold }), NOW, true).keys()]).toEqual(['warm', 'cold']);
  });

  it('measures warmth by the record\'s own TTL', () => {
    const hour: AgentRecord = { at: NOW - 30 * MIN, ttl: '1h', context: 1 };
    expect([...prune(records({ hour }), NOW, false).keys()]).toEqual(['hour']);
  });

  it('keeps at most the cap, dropping the oldest request first', () => {
    const r = records({
      a: { ...warm, at: NOW - 3 * MIN },
      b: { ...warm, at: NOW - MIN },
      c: { ...warm, at: NOW - 2 * MIN },
    });
    expect([...prune(r, NOW, true, 2).keys()].sort()).toEqual(['b', 'c']);
  });

  it('returns the same map when nothing goes', () => {
    const r = records({ warm });
    expect(prune(r, NOW, true)).toBe(r);
  });
});
