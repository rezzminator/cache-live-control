import { expect, test } from 'vitest';
import { decideWarm, type DecisionInput } from '../../plugins/cache-live-control/src/keepwarm/decision.ts';
const item = { id: 'a', expectedBackAt: null, wake: 'yes' as const };
const base: DecisionInput = { enabled: true, busy: false, currentEpoch: true, inFlight: false, known: true, context: 50000, minContext: 20000, lastSendAt: 0, now: 240000, ttl: '5m', warm1h: false, items: [item], pokes: { count: 0, max: 4 }, spent: 0, forecast: 8000, saved: 57500 };
test.each([
  [{}, 'warm', 'eligible'], [{ enabled: false }, 'stop', 'off'], [{ busy: true }, 'stop', 'busy'],
  [{ currentEpoch: false }, 'stop', 'stale'], [{ inFlight: true }, 'skip', 'in-flight'],
  [{ known: false }, 'stop', 'inventory-unknown'], [{ items: [] }, 'stop', 'nothing-pending'], [{ items: [], endedId: 'a' }, 'stop', 'ended'],
  [{ context: null }, 'stop', 'usage-unknown'], [{ context: NaN }, 'stop', 'usage-invalid'], [{ context: 19999 }, 'stop', 'small'],
  [{ lastSendAt: null }, 'stop', 'usage-unknown'], [{ ttl: '1h' }, 'stop', '1h-unproven'],
  [{ now: 300000 }, 'stop', 'cache-cold'], [{ now: 299999 }, 'stop', 'expiry-safety'], [{ now: 285000 }, 'stop', 'expiry-safety'],
  [{ now: 284999 }, 'warm', 'eligible'], [{ items: [{ ...item, wake: 'unknown' }] }, 'stop', 'wake-unknown'],
  [{ items: [{ ...item, wake: 'no' }] }, 'stop', 'cannot-wake'],
  [{ pokes: { count: 3, max: 4 } }, 'warm', 'eligible'], [{ pokes: { count: 4, max: 4 } }, 'stop', 'poke-limit'], [{ pokes: { count: 5, max: 4 } }, 'stop', 'poke-limit'],
  [{ pokes: { count: 1, max: 1 }, items: [], endedId: 'a' }, 'stop', 'ended'], [{ pokes: { count: 0, max: 0 } }, 'stop', 'usage-invalid'],
  [{ items: [{ ...item, expectedBackAt: 299999 }] }, 'skip', 'imminent'],
  [{ items: [{ ...item, expectedBackAt: 300000 }] }, 'skip', 'imminent'],
  [{ spent: 50000 }, 'stop', 'budget'], [{ spent: 49000 }, 'stop', 'marginal'], [{ spent: 48700 }, 'warm', 'eligible'],
  [{ items: [{ ...item, expectedBackAt: 100 }, { ...item, id: 'b' }] }, 'warm', 'eligible'],
  [{ now: -1 }, 'stop', 'usage-invalid'], [{ forecast: Infinity }, 'stop', 'usage-invalid'],
] as const)('decision %# %s', (patch, action, reason) => {
  let actual: unknown; try { actual = decideWarm({ ...base, ...patch } as DecisionInput); } catch (error) { actual = { reason: String(error) }; }
  expect(actual).toMatchObject({ action, reason });
});
test.each(['poke-failed', 'timer-failed', 'usage-unknown'] as const)('pure settlement stop %s', fault => {
  expect(decideWarm({ ...base, fault } as DecisionInput)).toMatchObject({ action: 'stop', reason: fault });
});

test.each(['running', 'idle', 'completed', 'failed', 'killed', 'unknown'])('sub-agent %s cannot be resumed by a warm', agentStatus => {
  expect(decideWarm({ ...base, agentStatus } as any)).toMatchObject({ action: 'stop', reason: 'agent-not-waiting' });
});
