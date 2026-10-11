import { describe, expect, test } from 'claude-code/testing';
import { cache, MIN, segment, START, world } from '../world.ts';

// Run by scripts/test-hook-variants.sh with the manifest defaults
// resumeGuard=block, resumeGuardMinTokens=50k, resumeGuardPrice=3, handoff=true
// and handoffDir=/hand.

describe('the options reach the guard and the handoff', () => {
  test('/cache shows them', async ($, on) => {
    world(on);
    await $.session.start(START);
    expect(await segment($, 'resume-guard')).toBe('resume-guard block (floor 50k, $3/M)');
    expect(await segment($, 'handoff')).toBe('handoff on (/hand)');
  });

  test('a spawned agent is asked for a handoff file named by its spawn call, after its own prompt', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.spawn($, { prompt: 'do X' });
    const call = w.spawned[0]!;
    expect(call.prompt.startsWith('do X\n\nBefore your final answer, write a handoff to ')).toBe(true);
    expect(call.prompt).toContain(`/hand/${call.tool_use_id}.md so a fresh agent can continue`);
  });

  test('the block shows the price, and points to the handoff file only once it exists', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const id = await w.spawn($, { name: 'researcher' });
    const file = `/hand/${w.spawned[0]!.tool_use_id}.md`;
    await w.agentStep($, id, 187_000);
    await w.agentComplete($, id);
    await w.clock.advance(20 * MIN);
    const without = await w.send($, id, 'carry on');
    expect(without.deny).toContain('= ~234k input-token equivalents ($0.70 at $3/M base input). Not sent.');
    w.files.add(file);
    const withFile = await w.send($, id, 'carry on');
    expect(withFile.deny).toContain(`($0.70 at $3/M base input). A handoff for it is at ${file}: spawn a fresh agent from it instead of resuming. Not sent.`);
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
