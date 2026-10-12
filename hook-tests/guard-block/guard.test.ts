import { describe, expect, test } from 'claude-code/testing';
import { cache, MIN, segment, START, world } from '../world.ts';

// Run by scripts/test-hook-variants.sh with the manifest defaults
// resumeGuard=block, resumeGuardMinTokens=50k and resumeGuardPrice=3.

describe('the options reach the guard', () => {
  test('/cache shows them', async ($, on) => {
    world(on);
    await $.session.start(START);
    expect(await segment($, 'resume-guard')).toBe('resume-guard block (floor 50k, $3/M)');
  });

  test('the block shows the price and names no file', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const id = await w.spawn($, { name: 'researcher' });
    await w.agentStep($, id, 187_000);
    await w.agentComplete($, id);
    await w.clock.advance(20 * MIN);
    const blocked = await w.send($, id, 'carry on');
    expect(blocked.deny).toContain('= ~234k input-token equivalents ($0.70 at $3/M base input). Not sent.');
    expect(w.calls).toEqual([]);
  });

  test('a live /cache guard word replaces the option', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(await cache($, 'guard floor 300k guard price off')).toBe('resume-guard block (floor 300k)');
    const id = await w.spawn($, { name: 'researcher' });
    await w.agentStep($, id, 187_000);
    await w.clock.advance(20 * MIN);
    expect((await w.send($, id, 'carry on')).deny).toBeUndefined();
  });
});
