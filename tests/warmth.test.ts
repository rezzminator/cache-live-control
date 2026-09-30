import { describe, expect, it } from 'vitest';
import {
  effectiveTtl,
  recordedTtl,
  variableAfter,
  warmChanges,
  warmForMs,
  warmNote,
  warmthLabel,
  type Records,
} from '../plugins/cache-live-control/src/warmth.ts';

const MIN = 60_000;
const NOW = 1_000 * MIN;

describe('records', () => {
  it('records 5m or 1h from the variable, anything else as automatic', () => {
    expect(recordedTtl('5m')).toBe('5m');
    expect(recordedTtl('1h')).toBe('1h');
    for (const v of [undefined, '', '2h']) expect(recordedTtl(v)).toBe('automatic');
  });

  it('assumes 1h for an automatic main chat and 5m for automatic sub-agents', () => {
    expect(effectiveTtl('main', { at: 0, ttl: 'automatic' })).toBe('1h');
    expect(effectiveTtl('agents', { at: 0, ttl: 'automatic' })).toBe('5m');
    expect(effectiveTtl('agents', { at: 0, ttl: '1h' })).toBe('1h');
  });

  it('is warm strictly before the request time plus the TTL', () => {
    const rec = { at: NOW - 5 * MIN, ttl: '5m' as const };
    expect(warmForMs('main', rec, NOW)).toBe(0);
    expect(warmForMs('main', rec, NOW - 1)).toBe(1);
    expect(warmForMs('main', undefined, NOW)).toBe(0);
  });

  it('returns main auto to the launch 1h', () => {
    expect(variableAfter('main', null, true)).toBe('1h');
    expect(variableAfter('main', null, false)).toBeUndefined();
    expect(variableAfter('agents', null, true)).toBeUndefined();
    expect(variableAfter('agents', '5m', true)).toBe('5m');
  });
});

describe('warmChanges', () => {
  const warmMain1h: Records = { main: { at: NOW - 19 * MIN, ttl: '1h' } };

  it('lets a cold party change at once', () => {
    expect(warmChanges({ main: '5m' }, { main: '1h' }, {}, NOW, false)).toEqual([]);
    expect(warmChanges({ main: '5m' }, { main: '1h' }, { main: { at: NOW - 61 * MIN, ttl: '1h' } }, NOW, false)).toEqual([]);
  });

  it('does not ask for a change to the value the variable already holds', () => {
    expect(warmChanges({ main: '1h' }, { main: '1h' }, warmMain1h, NOW, false)).toEqual([]);
  });

  it('does not ask when the target matches the TTL the warm cache was written at', () => {
    expect(warmChanges({ main: '1h' }, {}, { main: { at: NOW - MIN, ttl: 'automatic' } }, NOW, false)).toEqual([]);
  });

  it('asks for a warm party whose TTL would change', () => {
    expect(warmChanges({ main: '5m', agents: '5m' }, { main: '1h' }, warmMain1h, NOW, false)).toEqual([
      { party: 'main', ttl: '1h', automatic: false, may: false, target: '5m', leftMs: 41 * MIN, agoMs: 19 * MIN },
    ]);
  });

  it('asks, with "may", for auto on a warm party whose variable is set', () => {
    expect(warmChanges({ main: null }, { main: '1h' }, warmMain1h, NOW, false)).toEqual([
      { party: 'main', ttl: '1h', automatic: false, may: true, target: 'automatic', leftMs: 41 * MIN, agoMs: 19 * MIN },
    ]);
    expect(warmChanges({ main: null }, { main: '1h' }, warmMain1h, NOW, true)).toEqual([]);
  });

  it('assumes an automatic main chat is 1h, so 5m may rewrite it', () => {
    const [w] = warmChanges({ main: '5m' }, {}, { main: { at: NOW - 30 * MIN, ttl: 'automatic' } }, NOW, false);
    expect(w).toMatchObject({ ttl: '1h', automatic: true, may: true, leftMs: 30 * MIN });
  });

  it('takes automatic sub-agents as 5m: warm for 5 minutes only', () => {
    const agents = (ago: number): Records => ({ agents: { at: NOW - ago, ttl: 'automatic' } });
    expect(warmChanges({ agents: '1h' }, {}, agents(4 * MIN), NOW, false)).toMatchObject([{ party: 'agents', ttl: '5m', may: false }]);
    expect(warmChanges({ agents: '1h' }, {}, agents(5 * MIN), NOW, false)).toEqual([]);
  });
});

describe('lines', () => {
  const main = { party: 'main', ttl: '1h', automatic: false, may: false, target: '5m', leftMs: 41 * MIN, agoMs: 19 * MIN } as const;
  const agents = { party: 'agents', ttl: '5m', automatic: true, may: false, target: '1h', leftMs: 3 * MIN, agoMs: 2 * MIN } as const;

  it('notes one warm party', () => {
    expect(warmNote([main])).toBe("main's cache was warm (41m left), the next request may rewrite it");
  });

  it('says may have been for an assumed TTL or an auto target', () => {
    expect(warmNote([{ ...main, automatic: true, may: true }])).toBe("main's cache may have been warm (41m left), the next request may rewrite it");
  });

  it('names both parties in one note', () => {
    expect(warmNote([main, agents])).toBe("main's (41m left) and agents' (3m left) caches were warm, the next request may rewrite them");
    expect(warmNote([{ ...main, may: true }, agents])).toBe(
      "main's (41m left) and agents' (3m left) caches may have been warm, the next request may rewrite them",
    );
  });

  it('rounds minutes up and reads under a minute as such', () => {
    expect(warmNote([{ ...main, leftMs: 40 * MIN + 1 }])).toBe("main's cache was warm (41m left), the next request may rewrite it");
    expect(warmNote([{ ...agents, leftMs: 30_000 }])).toBe("agents' cache was warm (under a minute left), the next request may rewrite it");
  });

  it('labels warmth for the status line', () => {
    expect(warmthLabel('main', { at: NOW - 19 * MIN, ttl: '1h' }, NOW)).toBe('warm 41m');
    expect(warmthLabel('main', { at: NOW - 19 * MIN, ttl: 'automatic' }, NOW)).toBe('may be warm 41m');
    expect(warmthLabel('agents', { at: NOW - 6 * MIN, ttl: 'automatic' }, NOW)).toBe('cold');
    expect(warmthLabel('agents', undefined, NOW)).toBe('cold');
  });
});
