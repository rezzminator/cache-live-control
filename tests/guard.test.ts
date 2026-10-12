import { describe, expect, it } from 'vitest';
import type { AgentRecord, AgentRecords } from '../plugins/cache-live-control/src/agents.ts';
import { DEFAULT_FLOOR, guardStatus, guardVerdict, multiplier, OVERRIDE, resolveTarget, rewriteTtl, takeOverride, tokenText, type GuardInput } from '../plugins/cache-live-control/src/guard.ts';

const MIN = 60_000;
const NOW = 1_000 * MIN;

function records(entries: Record<string, Partial<AgentRecord>>): AgentRecords {
  return new Map(Object.entries(entries).map(([id, r]) => [id, { at: NOW, ttl: 'automatic', context: 0, ...r } as AgentRecord]));
}

describe('constants', () => {
  it('floors at 60k tokens by default and writes 1.25x at 5m, 2x at 1h', () => {
    expect(DEFAULT_FLOOR).toBe(60_000);
    expect(OVERRIDE).toBe('[resume-anyway]');
    expect(multiplier('5m')).toBe(1.25);
    expect(multiplier('1h')).toBe(2);
  });
});

describe('resolveTarget', () => {
  const r = records({
    a1: { name: 'researcher', at: NOW - 10 * MIN },
    a2: { name: 'researcher', at: NOW - MIN },
    a3: {},
  });

  it('takes an agent id the records know', () => {
    expect(resolveTarget('a3', r, [])).toBe('a3');
  });

  it('takes a name the records know, the most recent request first', () => {
    expect(resolveTarget('researcher', r, [])).toBe('a2');
  });

  it('takes a name or an id only the agent listing knows', () => {
    expect(resolveTarget('builder', r, [{ id: 'b9', name: 'builder' }])).toBe('b9');
    expect(resolveTarget('b9', r, [{ id: 'b9' }])).toBe('b9');
  });

  it('is undefined for a recipient no record or listing names', () => {
    expect(resolveTarget('nobody', r, [{ id: 'b9', name: 'builder' }])).toBeUndefined();
    expect(resolveTarget('', r, [])).toBeUndefined();
  });
});

describe('takeOverride', () => {
  it('strips a marker that begins the message, in any case, with the space after it', () => {
    expect(takeOverride('[resume-anyway] carry on')).toBe('carry on');
    expect(takeOverride('  [RESUME-ANYWAY]carry on')).toBe('carry on');
  });

  it('leaves a message without the marker at its start alone', () => {
    expect(takeOverride('carry on [resume-anyway]')).toBeUndefined();
    expect(takeOverride('carry on')).toBeUndefined();
    // A bare marker carries no message: it is no override, and the guard weighs it like any other.
    expect(takeOverride('[resume-anyway]')).toBeUndefined();
    expect(takeOverride(' [resume-anyway]   ')).toBeUndefined();
  });
});

describe('guardVerdict', () => {
  const base: GuardInput = {
    mode: 'block',
    floor: 60_000,
    record: { at: NOW - 20 * MIN, ttl: 'automatic', context: 187_000 },
    label: 'researcher',
    now: NOW,
    rewriteTtl: '5m',
  };

  it('blocks a cold, large target with the gap, the context and the rewrite in tokens x multiplier, naming the override', () => {
    expect(guardVerdict(base)).toEqual({
      kind: 'block',
      text:
        'agent researcher has been idle 20m and its prompt cache expired 15m ago (it was written at 5m), so resuming re-writes its whole context: ~187k tokens × 1.25 (a 5m cache write) = ~234k input-token equivalents. ' +
        'Not sent. To resume it anyway (for example it holds uncommitted work), send the same message beginning with [resume-anyway].',
    });
  });

  it('warns with the same facts and sends anyway', () => {
    const v = guardVerdict({ ...base, mode: 'warn' });
    expect(v.kind).toBe('warn');
    if (v.kind === 'warn') {
      expect(v.text).toMatch(/^agent researcher has been idle 20m and its prompt cache expired 15m ago/);
      expect(v.text).toMatch(/ Sent anyway: resumeGuard is warn\.$/);
      expect(v.text).not.toContain(OVERRIDE);
    }
  });

  it('prices the rewrite only when a price is set', () => {
    const v = guardVerdict({ ...base, price: 3 });
    expect(v).toMatchObject({ kind: 'block' });
    if (v.kind === 'block') expect(v.text).toContain('= ~234k input-token equivalents ($0.70 at $3/M base input). Not sent.');
    const plain = guardVerdict(base);
    if (plain.kind === 'block') expect(plain.text).not.toMatch(/\$/);
  });

  it('multiplies by 2 for a rewrite at 1h and names the TTL the record was written at', () => {
    const v = guardVerdict({ ...base, rewriteTtl: '1h', record: { ...base.record!, ttl: '5m' } });
    if (v.kind !== 'block') throw new Error('expected a block');
    expect(v.text).toContain('(it was written at 5m)');
    expect(v.text).toContain('~187k tokens × 2 (a 1h cache write) = ~374k input-token equivalents');
  });

  it('passes silently when the guard is off, the target is unknown, warm, small or its size unknown', () => {
    expect(guardVerdict({ ...base, mode: 'off' })).toEqual({ kind: 'pass' });
    expect(guardVerdict({ ...base, record: undefined })).toEqual({ kind: 'pass' });
    expect(guardVerdict({ ...base, record: { ...base.record!, at: NOW - 4 * MIN } })).toEqual({ kind: 'pass' });
    expect(guardVerdict({ ...base, record: { ...base.record!, context: 59_999 } })).toEqual({ kind: 'pass' });
    expect(guardVerdict({ ...base, record: { ...base.record!, context: 0 } })).toEqual({ kind: 'pass' });
  });

  it('acts at exactly the floor and exactly at the TTL', () => {
    expect(guardVerdict({ ...base, record: { ...base.record!, context: 60_000 } }).kind).toBe('block');
    expect(guardVerdict({ ...base, record: { ...base.record!, at: NOW - 5 * MIN } }).kind).toBe('block');
  });

  it('counts a record written at 1h warm for the hour', () => {
    expect(guardVerdict({ ...base, record: { ...base.record!, ttl: '1h', at: NOW - 59 * MIN } })).toEqual({ kind: 'pass' });
    expect(guardVerdict({ ...base, record: { ...base.record!, ttl: '1h', at: NOW - 61 * MIN } }).kind).toBe('block');
  });
});

describe('guardStatus', () => {
  it('shows the mode, the floor and the price', () => {
    expect(guardStatus({ mode: 'off', floor: 60_000 })).toBe('resume-guard off');
    expect(guardStatus({ mode: 'warn', floor: 60_000 })).toBe('resume-guard warn (floor 60k)');
    expect(guardStatus({ mode: 'block', floor: 1_500, price: 3 })).toBe('resume-guard block (floor 1500, $3/M)');
  });
});

describe('tokenText', () => {
  it('writes thousands as k, rounded, and small counts whole', () => {
    expect(tokenText(999)).toBe('999');
    expect(tokenText(1000)).toBe('1k');
    expect(tokenText(187_400)).toBe('187k');
    expect(tokenText(187_600)).toBe('188k');
  });
});

describe('rewriteTtl', () => {
  it('is the TTL the agents write at: 1h only when the variable (or the launch default) says 1h and nothing forces 5m', () => {
    expect(rewriteTtl({ agents: '1h' }, {})).toBe('1h');
    expect(rewriteTtl({ enable1h: '1' }, {})).toBe('1h');
    expect(rewriteTtl({ agents: '5m' }, {})).toBe('5m');
    expect(rewriteTtl({}, {})).toBe('5m');
    expect(rewriteTtl({ agents: 'soon' }, {})).toBe('5m');
    expect(rewriteTtl({ agents: '1h', force5m: '1' }, {})).toBe('5m');
    expect(rewriteTtl({ agents: '1h', force5m: '0' }, {})).toBe('1h');
  });
});
