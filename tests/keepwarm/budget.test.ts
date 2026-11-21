import { expect, test } from 'vitest';
import { allow, budgetLedger, closeLedger, emptySessionLedger, recordOutcome, recordWarm, rewriteSaved, pokeForecast, wakeForecast, warmSpend } from '../../plugins/cache-live-control/src/keepwarm/budget.ts';
function call<T>(fn: () => T): T | string { try { return fn(); } catch (error) { return String(error); } }
const usage = { input_tokens: 25, output_tokens: 3, cache_read_input_tokens: 49745, cache_creation_input_tokens: 807 };
test('exact budget examples and inclusive admission', () => {
  expect(call(() => rewriteSaved({ context: 50552, ttl: '5m' }))).toBe(58134.8);
  expect(call(() => rewriteSaved({ context: 50552, ttl: '1h' }))).toBe(96048.8);
  expect(call(() => warmSpend(usage))).toBe(6628.5);
  expect(call(() => allow({ spent: 0, forecast: 8013.2, saved: 58134.8 }))).toBe(true);
  expect(call(() => allow({ spent: 52485.3, forecast: 6399.2, saved: 58134.8 }))).toBe(false);
  expect(call(() => allow({ spent: 1, forecast: 2, saved: 3 }))).toBe(true);
  expect(call(() => allow({ spent: NaN, forecast: 2, saved: 3 }))).toBe(false);
});
test('one ledger owns actuals and estimated counterfactual', () => {
  const ledger = { context: 50000, ttl: '5m' as const, spent: 5000, warms: 1, allowance: 57500, protecting: 62500, remaining: 52500 };
  expect(call(() => budgetLedger({ context: 50000, ttl: '5m', spent: 5000, warms: 1 }))).toEqual(ledger);
  const base = { ledger, waitStartedAt: 0, originalExpiryAt: 300000, returnedAt: 400000, samePrefix: true, usage: { model: 'claude-haiku-5-5', input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 49000, cache_creation_input_tokens: 900 } };
  const hit = { elapsedMs: 400000, readPercent: 98, netSaved: 52500, reason: 'estimated' };
  expect(call(() => closeLedger(base))).toEqual(hit);
  expect(call(() => closeLedger({ ...base, returnedAt: 299999 }))).toEqual({ ...hit, elapsedMs: 299999, netSaved: -5000, reason: 'early' });
  expect(call(() => closeLedger({ ...base, usage: { ...base.usage, cache_read_input_tokens: 100 } }))).toEqual({ ...hit, readPercent: 10000 / 1100, netSaved: -5000, reason: 'miss' });
  expect(call(() => closeLedger({ ...base, samePrefix: false }))).toEqual({ ...hit, netSaved: null, reason: 'unknown' });
  expect(call(() => closeLedger({ ...base, usage: null }))).toEqual({ ...hit, readPercent: null, netSaved: null, reason: 'unknown' });
  const session = { spent: 0, warms: 0, episodes: 0, estimatedNet: 0, unknown: 0 };
  expect(call(emptySessionLedger)).toEqual(session);
  expect(call(() => recordWarm(session, usage))).toEqual({ ...session, spent: 6628.5, warms: 1 });
  expect(call(() => recordOutcome(session, { ...hit, reason: 'estimated' }))).toEqual({ ...session, episodes: 1, estimatedNet: 52500 });
  expect(call(() => recordOutcome(session, { ...hit, reason: 'unknown', netSaved: null }))).toEqual({ ...session, episodes: 1, unknown: 1 });
});
test('unsettled spend never becomes a realized saving estimate', () => {
  const ledger = { context: 50000, ttl: '5m' as const, spent: 5000, warms: 1, allowance: 57500, protecting: 62500, remaining: 52500 };
  expect(closeLedger({ ledger, waitStartedAt: 0, originalExpiryAt: 300000, returnedAt: 400000, samePrefix: true, usage: { input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 49000, cache_creation_input_tokens: 900 }, settled: false } as Parameters<typeof closeLedger>[0])).toMatchObject({ readPercent: 98, netSaved: null, reason: 'unknown' });
});

test('a first poke forecasts the conservative floor: read, written tail and poke, a thinking-sized reply', () => {
  expect(call(() => pokeForecast({ context: 50552, tail: 807, previous: null }))).toBe(11969.2);
  expect(call(() => pokeForecast({ context: 50000, tail: 0, previous: null }))).toBe(10300);
});
test('a later poke forecasts the observed spend of this thread\'s previous poke, never under the floor', () => {
  expect(call(() => pokeForecast({ context: 50000, tail: 3, previous: 55064 }))).toBe(55064);
  expect(call(() => pokeForecast({ context: 50000, tail: 3, previous: 6628.5 }))).toBe(10306);
});
test('a sub-agent poke adds the parent wake: its context read, notification and tail written, a reply', () => {
  expect(call(() => wakeForecast({ parentContext: 80000 }))).toBe(15300);
  expect(call(() => wakeForecast({ parentContext: 0 }))).toBe(7300);
});
