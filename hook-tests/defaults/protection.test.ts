import { describe, expect, test } from 'claude-code/testing';
import { AGENTS, cache, MAIN, MIN, segment, START, world } from '../world.ts';

// Run by scripts/test-hook-variants.sh with the manifest defaults: every piece
// starts off, and /cache sets each threshold live.

const OFF = 'auto-raise off · agent-raise off · resume-guard off · handoff off';
const INFO = { description: 'd', type: 'general-purpose' } as const;

describe('everything starts off', () => {
  test('/cache shows every piece off, and a cold, large agent is resumed without a word', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect((await cache($)).endsWith(` · ${OFF}`)).toBe(true);
    const id = await w.spawn($, { name: 'researcher' });
    expect(w.spawned[0]).toMatchObject({ prompt: 'work' });
    await w.agentStep($, id, 187_000);
    await w.agentComplete($, id);
    await w.clock.advance(30 * MIN);
    const sent = await w.send($, id, 'carry on');
    expect(sent.deny).toBeUndefined();
    expect(w.calls).toEqual([expect.objectContaining({ tool: 'SendMessage', to: id, message: 'carry on' })]);
    expect(w.toasts).toEqual([]);
  });

  test('the kit carries a spawn\'s parent and background flag to the hooks', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.spawn($, { parentAgentId: 'p1', background: true });
    expect(w.spawned[0]).toMatchObject({ parentAgentId: 'p1', background: true });
  });
});

describe('/cache guard: the cold-resume guard, set live', () => {
  test('blocks a cold, large target by name, passes the override with its marker removed, and lists both', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(await cache($, 'guard block')).toBe('resume-guard block (floor 60k)');
    const id = await w.spawn($, { name: 'researcher' });
    await w.agentStep($, id, 187_000);
    await w.agentComplete($, id);
    await w.clock.advance(20 * MIN);
    const blocked = await w.send($, 'researcher', 'carry on');
    expect(blocked.deny).toBe(
      'agent researcher has been idle 20m and its prompt cache expired 15m ago (it was written at 5m), so resuming re-writes its whole context: ~187k tokens × 1.25 (a 5m cache write) = ~234k input-token equivalents. ' +
        'Not sent. To resume it anyway (for example it holds uncommitted work), send the same message beginning with [resume-anyway].',
    );
    expect(w.calls).toEqual([]);
    const forced = await w.send($, 'researcher', '[resume-anyway] carry on');
    expect(forced.deny).toBeUndefined();
    expect(w.calls).toEqual([expect.objectContaining({ tool: 'SendMessage', to: 'researcher', message: 'carry on' })]);
    expect(await segment($, 'recent')).toBe('recent: resumed researcher anyway just now; blocked a resume of researcher (~187k tokens) just now');
  });

  test('passes a warm target, a small one, one never seen, and everything once the guard is off', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await cache($, 'guard block');
    const warm = await w.spawn($, { name: 'warm' });
    const small = await w.spawn($, { name: 'small' });
    const big = await w.spawn($, { name: 'big' });
    await w.agentStep($, small, 59_999);
    await w.agentStep($, big, 187_000);
    await w.clock.advance(20 * MIN);
    await w.agentStep($, warm, 187_000);
    await w.clock.advance(2 * MIN);
    for (const to of [warm, small, 'nobody']) expect((await w.send($, to, 'hi')).deny).toBeUndefined();
    expect(w.calls).toHaveLength(3);
    expect((await w.send($, big, 'hi')).deny).toMatch(/^agent big has been idle 22m/);
    await cache($, 'guard off');
    expect((await w.send($, big, 'hi')).deny).toBeUndefined();
  });

  test('warn sends the message, tells the sender what it cost, and toasts', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(await cache($, 'guard warn guard floor 100k')).toBe('resume-guard warn (floor 100k)');
    const id = await w.spawn($, { name: 'researcher' });
    await w.agentStep($, id, 187_000);
    await w.clock.advance(20 * MIN);
    const sent = await w.send($, id, 'carry on');
    expect(sent.deny).toBeUndefined();
    expect(w.calls).toEqual([expect.objectContaining({ message: 'carry on' })]);
    expect(sent.context).toEqual([expect.stringMatching(/^agent researcher has been idle 20m .* Sent anyway: resumeGuard is warn\.$/)]);
    expect(w.toasts).toEqual([expect.stringMatching(/^agent researcher has been idle 20m/)]);
    expect(await segment($, 'recent')).toBe('recent: warned about a resume of researcher (~187k tokens) just now');
  });

  test('a message to a sub-agent that cannot be checked goes through, and /cache says the check failed', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await cache($, 'guard block');
    const id = await w.spawn($, { name: 'researcher' });
    await w.agentStep($, id, 187_000);
    w.clock.fails = true;
    const sent = await w.send($, id, 'carry on');
    w.clock.fails = false;
    expect(sent.deny).toBeUndefined();
    expect(w.calls).toHaveLength(1);
    // The kit reports a throwing bottom handler as "no implementation", whatever it threw.
    expect(w.logs.join('\n')).toMatch(/checking the resume of ag1 failed, the message is sent: no implementation for clock\.now/);
    expect(await segment($, 'recent')).toBe('recent: could not check a resume of ag1: no implementation for clock.now just now');
  });

  test('a recipient named only by the agent listing is resolved from it', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await cache($, 'guard block');
    const id = await w.spawn($, {});
    await w.agentStep($, id, 187_000);
    w.agentList.push({ id, name: 'builder', status: 'completed', ...INFO });
    await w.clock.advance(20 * MIN);
    expect((await w.send($, 'builder', 'hi')).deny).toMatch(/^agent builder has been idle 20m/);
  });
});

describe('what the guard must not do', () => {
  test('a running target passes: the message reaches it at its next step and forces no rewrite of its own', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await cache($, 'guard block');
    const id = await w.spawn($, { name: 'researcher' });
    await w.agentStep($, id, 187_000);
    w.agentList.push({ id, name: 'researcher', status: 'running', ...INFO });
    await w.clock.advance(20 * MIN);
    expect((await w.send($, id, 'carry on')).deny).toBeUndefined();
    expect(w.calls).toHaveLength(1);
  });

  test('the override marker is removed with the guard off too', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const id = await w.spawn($, {});
    await w.send($, id, '[resume-anyway] carry on');
    expect(w.calls).toEqual([expect.objectContaining({ tool: 'SendMessage', message: 'carry on' })]);
  });

  test('an agent request in flight when the conversation ends leaves no record in the next one', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await cache($, 'guard block');
    const id = await w.spawn($, { name: 'researcher' });
    await w.agentStep($, id, 187_000);
    w.clock.during = async () => {
      await $.session.end({ sessionId: 's1' } as never);
    };
    await w.agentStep($, id, 187_000);
    await w.clock.advance(20 * MIN);
    expect((await w.send($, id, 'carry on')).deny).toBeUndefined();
  });
});

describe('a sub-agent request with the agents\' reactive raise off', () => {
  test('is not held: it reaches the model while its record is still being noted', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const id = await w.spawn($, {});
    let seen = -1;
    w.clock.during = async () => {
      // Yields long enough for a request that is not held to reach the bottom.
      for (let i = 0; i < 200; i += 1) await Promise.resolve();
      seen = w.agentRequests.length;
    };
    await w.agentStep($, id);
    expect(seen).toBe(1);
  });
});

describe('/cache with a TTL and a setting', () => {
  test('a failed TTL write still applies the setting, and the reply says both', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    w.refused.add(AGENTS);
    expect(await cache($, 'agents 1h guard block')).toBe('failed, the TTL may be unchanged: no implementation for env.set · resume-guard block (floor 60k)');
    expect(await segment($, 'resume-guard')).toBe('resume-guard block (floor 60k)');
  });
});

describe('/cache raise N|off: the main chat\'s raise, set live', () => {
  test('raise 1 switches it on from the next wake, and raise off switches it off', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(await cache($, 'main 5m raise 1')).toBe('main 5m · agents automatic · auto-raise counting 0 of 1 expiries');
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(w.requests).toEqual(['5m', '1h']);
    expect(await cache($, 'raise off')).toBe('auto-raise off');
    expect(await cache($, 'raise 4')).toBe('auto-raise idle: main is 1h');
  });
});

describe('/cache agents raise, agents waiting: the agents\' raise, set live', () => {
  test('an agent that launches a background child holds the agents at 1h until its turn ends', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(await cache($, 'agents waiting on agents raise 2')).toBe('agent-raise ready (waiting, after 2 expiries)');
    const lead = await w.spawn($, { name: 'lead' });
    await w.agentStep($, lead);
    await w.spawn($, { parentAgentId: lead, background: true });
    expect(w.env.get(AGENTS)).toBe('1h');
    await w.agentStep($, lead);
    expect(w.agentRequests.map((r) => r.ttl)).toEqual([undefined, '1h']);
    await w.agentComplete($, lead);
    expect(w.env.get(AGENTS)).toBeUndefined();
    expect(await cache($, 'agents waiting off agents raise off')).toBe('agent-raise off');
    expect(w.sets.filter((s) => s.name === MAIN)).toEqual([]);
  });
});

describe('/cache handoff on|off', () => {
  test('asks each spawned sub-agent for a handoff file under the plugin\'s data directory, and stops when off', async ($, on) => {
    const w = world(on, { HOME: '/hm' });
    await $.session.start(START);
    expect(await cache($, 'handoff on')).toBe('handoff on (/hm/.claude/plugins/data/cache-live-control-inline/handoffs)');
    await w.spawn($, { prompt: 'do X' });
    const first = w.spawned[0]!;
    expect(first.prompt).toMatch(/^do X\n\nBefore your final answer, write a handoff to /);
    expect(first.prompt).toContain(`/hm/.claude/plugins/data/cache-live-control-inline/handoffs/${first.tool_use_id}.md`);
    expect(await cache($, 'handoff off')).toBe('handoff off');
    await w.spawn($, { prompt: 'do Y' });
    expect(w.spawned[1]!.prompt).toBe('do Y');
  });

  test('a configured directory is not needed from the environment: CLAUDE_CONFIG_DIR wins over HOME', async ($, on) => {
    const w = world(on, { HOME: '/hm', CLAUDE_CONFIG_DIR: '/cfg' });
    await $.session.start(START);
    expect(await cache($, 'handoff on')).toBe('handoff on (/cfg/plugins/data/cache-live-control-inline/handoffs)');
    void w;
  });

  test('says there is no directory, and asks for nothing, when none can be derived', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(await cache($, 'handoff on')).toBe('handoff on, no directory: set handoffDir');
    await w.spawn($, { prompt: 'do X' });
    expect(w.spawned[0]!.prompt).toBe('do X');
  });
});

describe('a bad /cache setting', () => {
  test('changes nothing and says why', async ($, on) => {
    world(on);
    await $.session.start(START);
    expect(await cache($, 'guard maybe')).toMatch(/^nothing changed: guard needs off, warn, block, floor N or price N; usage: /);
    expect((await cache($)).endsWith(` · ${OFF}`)).toBe(true);
  });
});
