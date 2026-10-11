import { describe, expect, test, type Engine } from 'claude-code/testing';
import { AGENTS, cache, MAIN, MIN, segment, START, world } from '../world.ts';

// Run by scripts/test-hook-variants.sh with the manifest defaults subagentTtl=5m,
// agentRaiseWaiting=true and agentRaiseAfterExpiries=2.

const READY = 'agent-raise ready (waiting, after 2 expiries)';

function listed(id: string, status: string, name?: string) {
  return { id, status, description: 'd', type: 'general-purpose', ...(name === undefined ? {} : { name }) };
}

describe('agentRaiseWaiting: an agent that launches background work', () => {
  test('has its turn-ending request at 1h, and the variable goes back to 5m when that turn ends', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await segment($, 'agent-raise')).toBe(READY);
    const lead = await w.spawn($, { name: 'lead' });
    await w.agentStep($, lead);
    await w.spawn($, { parentAgentId: lead, background: true, name: 'child' });
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(await segment($, 'agent-raise')).toBe('agent-raise holding agents at 1h for lead (since just now)');
    expect(await cache($)).toMatch(/agents 1h \(agent auto-raise \(shared 1h\), /);
    await w.agentStep($, lead);
    expect(w.agentRequests.map((r) => r.ttl)).toEqual(['5m', '1h']);
    await w.agentComplete($, lead);
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await segment($, 'agent-raise')).toBe(READY);
    expect(await cache($)).toMatch(/agents 5m \(option subagentTtl, /);
    expect(await segment($, 'recent')).toBe('recent: handed the agents variable back (5m) just now; raised the agents to 1h for lead (waiting) just now');
    expect(w.sets.filter((s) => s.name === MAIN)).toEqual([]);
  });

  test('a Bash call with run_in_background by an agent does the same; a foreground one, or the main chat\'s, does not', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    await w.bash($, 'sleep 600', true);
    await w.bash($, 'ls', false, lead);
    await w.spawn($, { background: true });
    await w.spawn($, { parentAgentId: lead, background: false });
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(w.sets.filter((s) => s.name === AGENTS).map((s) => s.value)).toEqual(['5m']);
    await w.bash($, 'sleep 600', true, lead);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(w.calls.filter((c) => c['tool'] === 'Bash')).toHaveLength(3);
    await w.agentStep($, lead);
    await w.agentComplete($, lead);
    expect(w.env.get(AGENTS)).toBe('5m');
  });

  test('stays at 1h while another agent still holds it', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const a = await w.spawn($, { name: 'a' });
    const b = await w.spawn($, { name: 'b' });
    await w.bash($, 'x', true, a);
    await w.bash($, 'y', true, b);
    await w.agentStep($, a);
    await w.agentComplete($, a);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(await segment($, 'agent-raise')).toBe('agent-raise holding agents at 1h for b (since just now)');
    await w.agentStep($, b);
    await w.agentComplete($, b);
    expect(w.env.get(AGENTS)).toBe('5m');
  });
});

describe('agentRaiseAfterExpiries: an agent whose own cache expired N times', () => {
  test('is written at 1h from its Nth expired request on, and held until the agent finished', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const id = await w.spawn($, { name: 'sleeper' });
    await w.agentStep($, id);
    await w.clock.advance(6 * MIN);
    await w.agentStep($, id);
    expect(w.env.get(AGENTS)).toBe('5m');
    await w.clock.advance(6 * MIN);
    await w.agentStep($, id);
    expect(w.agentRequests.map((r) => r.ttl)).toEqual(['5m', '5m', '1h']);
    expect(await segment($, 'agent-raise')).toBe('agent-raise holding agents at 1h for sleeper (since just now)');
    w.agentList.push(listed(id, 'waiting', 'sleeper'));
    await w.agentComplete($, id);
    expect(w.env.get(AGENTS)).toBe('1h');
    w.agentList[0]!.status = 'completed';
    await w.agentComplete($, id);
    expect(w.env.get(AGENTS)).toBe('5m');
  });

  test('counts each agent on its own', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const a = await w.spawn($, {});
    const b = await w.spawn($, {});
    for (const id of [a, b, a, b]) {
      await w.agentStep($, id);
      await w.clock.advance(6 * MIN);
    }
    expect(w.env.get(AGENTS)).toBe('5m');
  });

  test('lets go of an agent idle for an hour', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const id = await w.spawn($, {});
    const other = await w.spawn($, {});
    for (let i = 0; i < 3; i += 1) {
      await w.agentStep($, id);
      await w.clock.advance(6 * MIN);
    }
    expect(w.env.get(AGENTS)).toBe('1h');
    await w.clock.advance(61 * MIN);
    await w.agentStep($, other);
    expect(w.env.get(AGENTS)).toBe('5m');
  });
});

describe('what outranks or stops the agents\' raise', () => {
  async function holding($: Engine, w: ReturnType<typeof world>) {
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    await w.bash($, 'sleep 600', true, lead);
    expect(w.env.get(AGENTS)).toBe('1h');
    return lead;
  }

  test('a typed /cache agents 1h lets go of the holders and stays', async ($, on) => {
    const w = world(on);
    const lead = await holding($, w);
    expect(await cache($, 'agents 1h')).toBe('main automatic · agents 1h');
    expect(await segment($, 'agent-raise')).toBe('agent-raise idle: agents is 1h');
    await w.agentStep($, lead);
    await w.agentComplete($, lead);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(await cache($)).toMatch(/agents 1h \(set by \/cache, /);
  });

  test('a typed /cache agents 5m switches the raise off for the session', async ($, on) => {
    const w = world(on);
    const lead = await holding($, w);
    await cache($, 'agents 5m');
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await segment($, 'agent-raise')).toBe('agent-raise off: /cache agents 5m was typed this session');
    await w.bash($, 'sleep 600', true, lead);
    expect(w.env.get(AGENTS)).toBe('5m');
    await cache($, 'agents waiting on');
    expect(await segment($, 'agent-raise')).toBe(READY);
  });

  test('agents waiting off and agents raise off hand the variable back', async ($, on) => {
    const w = world(on);
    await holding($, w);
    expect(await cache($, 'agents waiting off')).toBe('agent-raise ready (after 2 expiries)');
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await cache($, 'agents raise off')).toBe('agent-raise off');
  });

  test('FORCE_PROMPT_CACHING_5M stops it', async ($, on) => {
    const w = world(on, { FORCE_PROMPT_CACHING_5M: '1' });
    await $.session.start(START);
    const lead = await w.spawn($, {});
    await w.bash($, 'sleep 600', true, lead);
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await segment($, 'agent-raise')).toBe('agent-raise inactive: FORCE_PROMPT_CACHING_5M is set');
  });

  test('a new conversation lets go of every holder', async ($, on) => {
    const w = world(on);
    await holding($, w);
    await $.session.end({ sessionId: 's1' } as never);
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await segment($, 'agent-raise')).toBe(READY);
  });

  test('a refused write is shown, claims no TTL, and the next launch tries again', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, {});
    w.refused.add(AGENTS);
    await w.bash($, 'sleep 600', true, lead);
    expect(w.env.get(AGENTS)).toBe('5m');
    // The kit reports a throwing bottom handler as "no implementation", whatever it threw.
    expect(await segment($, 'agent-raise')).toBe('agent-raise failed, the TTL may be unchanged: no implementation for env.set');
    w.refused.delete(AGENTS);
    await w.bash($, 'sleep 600', true, lead);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(await segment($, 'agent-raise')).toBe('agent-raise holding agents at 1h for ag1 (since just now)');
  });

  test('a variable someone else changed meanwhile is not overwritten when the holders let go', async ($, on) => {
    const w = world(on);
    const lead = await holding($, w);
    w.env.set(AGENTS, '5m');
    await w.agentStep($, lead);
    await w.agentComplete($, lead);
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(w.sets.filter((s) => s.name === AGENTS).map((s) => s.value)).toEqual(['5m', '1h']);
  });
});

describe('what lands while the agents\' raise is writing', () => {
  test('a second launch while the first 1h is being written is held too', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const a = await w.spawn($, { name: 'a' });
    const b = await w.spawn($, { name: 'b' });
    w.during.set = async () => {
      await w.bash($, 'y', true, b);
    };
    await w.bash($, 'x', true, a);
    expect(w.env.get(AGENTS)).toBe('1h');
    await w.agentStep($, a);
    await w.agentComplete($, a);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(await segment($, 'agent-raise')).toBe('agent-raise holding agents at 1h for b (since just now)');
    await w.agentStep($, b);
    await w.agentComplete($, b);
    expect(w.env.get(AGENTS)).toBe('5m');
  });

  test('every holder letting go while the 1h is being written (agents waiting off) hands the variable back once it lands', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    w.during.set = async () => {
      await cache($, 'agents waiting off');
    };
    await w.bash($, 'x', true, lead);
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await cache($)).toMatch(/agents 5m \(option subagentTtl, /);
  });

  test('a session end while the 1h is being written hands the variable back once it lands', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    w.during.set = async () => {
      await $.session.end({ sessionId: 's1' } as never);
    };
    await w.bash($, 'x', true, lead);
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await segment($, 'agent-raise')).toBe(READY);
  });

  test('an agent that launches while the variable is being handed back gets the 1h again', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const a = await w.spawn($, { name: 'a' });
    const b = await w.spawn($, { name: 'b' });
    await w.bash($, 'x', true, a);
    await w.agentStep($, a);
    w.during.set = async () => {
      await w.bash($, 'y', true, b);
    };
    await w.agentComplete($, a);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(await segment($, 'agent-raise')).toBe('agent-raise holding agents at 1h for b (since just now)');
    await w.agentStep($, b);
    expect(w.agentRequests.at(-1)).toEqual({ agentId: b, ttl: '1h' });
    await w.agentComplete($, b);
    expect(w.env.get(AGENTS)).toBe('5m');
  });

  test('a /cache agents 1h typed while the variable is being handed back stands, credited to /cache', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    await w.bash($, 'x', true, lead);
    await w.agentStep($, lead);
    w.during.set = async () => {
      await cache($, 'agents 1h');
    };
    await w.agentComplete($, lead);
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(await cache($)).toMatch(/agents 1h \(set by \/cache, /);
  });

  test('a launch while a typed /cache agents 5m is being written never leaves the agents at 1h', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    w.during.set = async () => {
      await w.bash($, 'x', true, lead);
    };
    await cache($, 'agents 5m');
    expect(w.env.get(AGENTS)).toBe('5m');
    expect(await segment($, 'agent-raise')).toBe('agent-raise off: /cache agents 5m was typed this session');
    expect(await cache($)).toMatch(/agents 5m \(set by \/cache, /);
  });
});

describe('a failed read on the agents\' raise shows in /cache', () => {
  test('a launch whose clock read failed is shown, and the next launch that reads clears it', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    w.clock.fails = true;
    await w.bash($, 'x', true, lead);
    w.clock.fails = false;
    expect(w.env.get(AGENTS)).toBe('5m');
    // The kit reports a throwing bottom handler as "no implementation", whatever it threw.
    expect(await segment($, 'agent-raise')).toBe('agent-raise failed, the TTL may be unchanged: holding the agents at 1h for lead failed: no implementation for clock.now');
    await w.bash($, 'x', true, lead);
    expect(await segment($, 'agent-raise')).toBe('agent-raise holding agents at 1h for lead (since just now)');
  });

  test('a request whose reads failed is shown while the reactive raise is on, and the next request that reads clears it', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const id = await w.spawn($, { name: 'worker' });
    w.reads.fails = true;
    await w.agentStep($, id);
    w.reads.fails = false;
    expect(await segment($, 'agent-raise')).toBe('agent-raise failed, the TTL may be unchanged: checking a request of worker failed: no implementation for env.get');
    await w.agentStep($, id);
    expect(await segment($, 'agent-raise')).toBe(READY);
  });

  test('a waiting holder is let go at its turn end even when the clock fails', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    await w.bash($, 'x', true, lead);
    await w.agentStep($, lead);
    w.clock.fails = true;
    await w.agentComplete($, lead);
    w.clock.fails = false;
    expect(w.env.get(AGENTS)).toBe('5m');
  });

  test('a sleeper whose agent list cannot be read at its turn end stays held, and /cache says why', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const id = await w.spawn($, { name: 'sleeper' });
    for (let i = 0; i < 3; i += 1) {
      await w.agentStep($, id);
      if (i < 2) await w.clock.advance(6 * MIN);
    }
    expect(w.env.get(AGENTS)).toBe('1h');
    w.listing.fails = true;
    await w.agentComplete($, id);
    w.listing.fails = false;
    expect(w.env.get(AGENTS)).toBe('1h');
    expect(await segment($, 'agent-raise')).toBe('agent-raise failed, the TTL may be unchanged: reading the agent list at the end of a turn of sleeper failed, it stays held: no implementation for agent.list');
  });

  test('a hand-back that failed when the raise was switched off is shown, not "off"', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    const lead = await w.spawn($, { name: 'lead' });
    await w.bash($, 'x', true, lead);
    w.refused.add(AGENTS);
    expect(await cache($, 'agents waiting off agents raise off')).toBe('agent-raise failed, the TTL may be unchanged: handing the agents variable back failed: no implementation for env.set');
  });
});
