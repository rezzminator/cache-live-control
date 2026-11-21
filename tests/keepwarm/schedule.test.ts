import { expect, test } from 'vitest';
import { isLate, nextFireAt, WARM_1H } from '../../plugins/cache-live-control/src/keepwarm/schedule.ts';
test.each([['5m', 1792247650124], ['1h', 1792250290124]] as const)('80%% %s', (ttl, expected) => {
  let actual: unknown; try { actual = nextFireAt({ lastSendAt: 1792247410124, ttl }); } catch (error) { actual = String(error); }
  expect(actual).toBe(expected);
});
test.each([[1792247710124, true], [1792247710123, false]])('expiry %s', (now, expected) => {
  let actual: unknown; try { actual = isLate({ lastSendAt: 1792247410124, ttl: '5m', now: Number(now) }); } catch (error) { actual = String(error); }
  expect(actual).toBe(expected);
});
test('1h refresh is enabled', () => expect(WARM_1H).toBe(true));
