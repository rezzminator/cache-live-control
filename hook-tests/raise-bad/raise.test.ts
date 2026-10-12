import { describe, expect, test } from 'claude-code/testing';
import { cache, MAIN, MIN, START, world } from '../world.ts';

// Run by scripts/test-hook-variants.sh with the manifest defaults mainTtl=5m and
// raiseAfterExpiries="abc": a bad option is ignored by name, and /cache shows it.

describe('a bad raiseAfterExpiries', () => {
  test('is named by /cache, leaves the auto-raise off, and the main TTL alone', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    for (let i = 0; i < 3; i += 1) {
      await w.clock.advance(6 * MIN);
      await w.typed($);
    }
    expect(w.requests).toEqual(['5m', '5m', '5m', '5m']);
    expect(w.env.get(MAIN)).toBe('5m');
    expect(await cache($)).toMatch(/ · auto-raise off · resume-guard off · handoff off · option raiseAfterExpiries "abc" ignored: use a whole number of 1 or more, or empty$/);
  });
});
