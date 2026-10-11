import { describe, expect, it } from 'vitest';
import {
  contextOf,
  labelOf,
  noteRequest,
  noteSpawn,
  noteUsage,
  prune,
  resetExpired,
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
  it('records the first request of an agent, not expired', () => {
    const out = noteRequest(EMPTY, 'a1', { at: NOW, ttl: 'automatic' });
    expect(out.expired).toBe(false);
    expect(out.count).toBe(0);
    expect(out.records.get('a1')).toEqual({ at: NOW, ttl: 'automatic', context: 0, expired: 0 });
  });

  it('counts a request whose own previous cache (5m for automatic) is 5 minutes old or more as expired', () => {
    const before = records({ a1: { at: NOW - 5 * MIN, ttl: 'automatic', context: 90_000, expired: 0 } });
    const out = noteRequest(before, 'a1', { at: NOW, ttl: 'automatic' });
    expect(out.expired).toBe(true);
    expect(out.count).toBe(1);
    expect(out.records.get('a1')).toEqual({ at: NOW, ttl: 'automatic', context: 90_000, expired: 1 });
  });

  it('does not count a request a millisecond inside the TTL, and counts from the agent\'s own record only', () => {
    const before = records({
      a1: { at: NOW - 5 * MIN + 1, ttl: '5m', context: 0, expired: 0 },
      a2: { at: NOW - 30 * MIN, ttl: '5m', context: 0, expired: 0 },
    });
    expect(noteRequest(before, 'a1', { at: NOW, ttl: '5m' }).expired).toBe(false);
    expect(noteRequest(before, 'a3', { at: NOW, ttl: '5m' }).expired).toBe(false);
  });

  it('measures a record written at 1h against an hour', () => {
    const before = records({ a1: { at: NOW - 59 * MIN, ttl: '1h', context: 0, expired: 2 } });
    expect(noteRequest(before, 'a1', { at: NOW, ttl: '5m' })).toMatchObject({ expired: false, count: 2 });
    expect(noteRequest(before, 'a1', { at: NOW + 2 * MIN, ttl: '5m' })).toMatchObject({ expired: true, count: 3 });
  });

  it('keeps the spawn, name and parent noted at spawn, and never changes its input', () => {
    const spawned = noteSpawn(EMPTY, 'a1', { spawn: 'tu1', name: 'researcher', parentId: 'p1', at: NOW - MIN });
    const out = noteRequest(spawned, 'a1', { at: NOW, ttl: '5m' });
    expect(out.records.get('a1')).toEqual({ at: NOW, ttl: '5m', context: 0, expired: 0, spawn: 'tu1', name: 'researcher', parentId: 'p1' });
    expect(spawned.get('a1')?.at).toBe(NOW - MIN);
  });
});

describe('noteUsage, noteSpawn, resetExpired, labelOf', () => {
  it('sets the context of a known agent and ignores an unknown one', () => {
    const before = records({ a1: { at: NOW, ttl: '5m', context: 0, expired: 0 } });
    expect(noteUsage(before, 'a1', 187_000).get('a1')?.context).toBe(187_000);
    expect(noteUsage(before, 'zz', 5)).toBe(before);
  });

  it('notes a spawn: the agent id, the spawn call, its name and parent', () => {
    expect(noteSpawn(EMPTY, 'a1', { spawn: 'tu1', name: 'researcher', parentId: 'p1', at: NOW }).get('a1')).toEqual({
      at: NOW,
      ttl: 'automatic',
      context: 0,
      expired: 0,
      pending: true,
      spawn: 'tu1',
      name: 'researcher',
      parentId: 'p1',
    });
  });

  it('counts no expiry for the first request after a spawn, however late, and the next one counts as usual', () => {
    const spawned = noteSpawn(EMPTY, 'a1', { spawn: 'tu1', at: NOW - 30 * MIN });
    const first = noteRequest(spawned, 'a1', { at: NOW, ttl: '5m' });
    expect(first).toMatchObject({ expired: false, count: 0 });
    expect(first.records.get('a1')).not.toHaveProperty('pending');
    expect(noteRequest(first.records, 'a1', { at: NOW + 6 * MIN, ttl: '5m' })).toMatchObject({ expired: true, count: 1 });
  });

  it('zeroes every expired count', () => {
    const before = records({ a1: { at: NOW, ttl: '5m', context: 1, expired: 3 }, a2: { at: NOW, ttl: '5m', context: 1, expired: 1 } });
    const out = resetExpired(before);
    expect([...out.values()].map((r) => r.expired)).toEqual([0, 0]);
    expect(before.get('a1')?.expired).toBe(3);
  });

  it('labels an agent by its name, else its id', () => {
    const r = records({ a1: { at: NOW, ttl: '5m', context: 0, expired: 0, name: 'researcher' }, a2: { at: NOW, ttl: '5m', context: 0, expired: 0 } });
    expect(labelOf(r, 'a1')).toBe('researcher');
    expect(labelOf(r, 'a2')).toBe('a2');
    expect(labelOf(r, 'unknown')).toBe('unknown');
  });
});

describe('prune', () => {
  const warm: AgentRecord = { at: NOW - MIN, ttl: 'automatic', context: 1, expired: 0 };
  const cold: AgentRecord = { at: NOW - 30 * MIN, ttl: 'automatic', context: 1, expired: 0 };

  it('forgets an agent whose cache can no longer be warm when nothing needs it', () => {
    const out = prune(records({ warm, cold }), NOW, false);
    expect([...out.keys()]).toEqual(['warm']);
  });

  it('keeps a cold agent while the resume guard or the reactive raise needs it', () => {
    expect([...prune(records({ warm, cold }), NOW, true).keys()]).toEqual(['warm', 'cold']);
  });

  it('measures warmth by the record\'s own TTL', () => {
    const hour: AgentRecord = { at: NOW - 30 * MIN, ttl: '1h', context: 1, expired: 0 };
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
