import { describe, expect, test, type Engine } from 'claude-code/testing';
import { AGENTS, cache, MAIN, MIN, raiseLine, START, world } from '../world.ts';

// Run by scripts/test-hook-variants.sh with the manifest defaults mainTtl=5m,
// raiseAfterExpiries=2 and ttlNotice=true: the user's own setup.

const FIVE = /cache lives 5 minutes/;
const HOUR = /cache lives 1 hour/;

describe('auto-raise after 2 expired wake-ups', () => {
  test('the 1st expired wake goes out at 5m, the 2nd at 1h, and main stays at 1h', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(await raiseLine($)).toBe('auto-raise counting 0 of 2 expiries');
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(w.requests).toEqual(['5m', '5m', '1h', '1h']);
    expect(w.env.get(MAIN)).toBe('1h');
    expect(await raiseLine($)).toBe('auto-raise fired 6m ago');
    expect(await cache($)).toMatch(/^main 1h \(auto-raise, option raiseAfterExpiries, warm 60m\) · /);
  });

  test('a wake inside the 5m, or the first request of the session, counts nothing', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(4 * MIN);
    await w.typed($);
    await w.clock.advance(4 * MIN);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 0 of 2 expiries');
    expect(w.requests).toEqual(['5m', '5m', '5m']);
  });

  test('a prompt typed while a turn runs, or delivered into it, is no wake', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await $.prompt.submit({ text: 'queued', wait: true, origin: { kind: 'composer' }, turnId: 'running' });
    expect(await raiseLine($)).toBe('auto-raise counting 0 of 2 expiries');
  });

  test('a background task returning, or a scheduled trigger, wakes main like a typed prompt', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($, '<task-notification>', 'task-notification');
    await w.clock.advance(6 * MIN);
    await w.typed($, 'tick', 'scheduled-trigger');
    expect(w.requests).toEqual(['5m', '5m', '1h']);
  });
});

describe('the TTL notice stays in step with the raise', () => {
  test('the note on the waking prompt names 1h, and the variable was already 1h when the prompt reached the model', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(MIN);
    await w.typed($);
    expect(w.promptsSaw).toEqual(['5m', '5m', '1h', '1h']);
    expect(w.contexts).toEqual([[expect.stringMatching(FIVE)], undefined, [expect.stringMatching(HOUR)], undefined]);
    expect(w.requests).toEqual(['5m', '5m', '1h', '1h']);
  });

  test('a background task returning carries the 1h note on its own prompt', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($, '<task-notification>', 'task-notification');
    expect(w.requests).toEqual(['5m', '5m', '1h']);
    expect(w.contexts[2]).toEqual([expect.stringMatching(HOUR)]);
  });

  test('a wake no prompt.submit hook sees (a self-inject) still goes out at 1h, carries no note, and the next prompt names 1h', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.turn($, 'injected');
    expect(w.requests).toEqual(['5m', '5m', '1h']);
    expect(w.contexts).toHaveLength(2);
    expect(w.env.get(MAIN)).toBe('1h');
    await w.clock.advance(MIN);
    await w.typed($);
    expect(w.contexts[2]).toEqual([expect.stringMatching(HOUR)]);
  });
});

describe('an explicit /cache main takes precedence', () => {
  test('/cache main 5m after the first expiry resets the count and the raise never overrides it', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await cache($, 'main 5m');
    expect(await raiseLine($)).toBe('auto-raise off: /cache main 5m was typed this session');
    for (let i = 0; i < 3; i += 1) {
      await w.clock.advance(6 * MIN);
      await w.typed($);
    }
    expect(w.requests).toEqual(['5m', '5m', '5m', '5m', '5m']);
    expect(w.env.get(MAIN)).toBe('5m');
  });

  test('/cache main 5m after the raise fired puts main back to 5m for good', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    for (let i = 0; i < 2; i += 1) {
      await w.clock.advance(6 * MIN);
      await w.typed($);
    }
    expect(w.env.get(MAIN)).toBe('1h');
    await cache($, 'main 5m');
    for (let i = 0; i < 3; i += 1) {
      await w.clock.advance(6 * MIN);
      await w.typed($);
    }
    expect(w.requests).toEqual(['5m', '5m', '1h', '5m', '5m', '5m']);
  });

  test('/cache main 5m whose write fails still switches the raise off: the word typed wins', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    w.refused.add(MAIN);
    expect(await cache($, 'main 5m')).toMatch(/failed, the TTL may be unchanged/);
    w.refused.delete(MAIN);
    expect(await raiseLine($)).toBe('auto-raise off: /cache main 5m was typed this session');
    for (let i = 0; i < 2; i += 1) {
      await w.clock.advance(6 * MIN);
      await w.typed($);
    }
    expect(w.requests).toEqual(['5m', '5m', '5m', '5m']);
  });

  test('any other /cache main resets the count; a /cache of the agents alone does not', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await cache($, 'agents 1h');
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
    await cache($, 'main auto');
    expect(await raiseLine($)).toBe('auto-raise idle: main is automatic');
    w.env.set(MAIN, '5m');
    expect(await raiseLine($)).toBe('auto-raise counting 0 of 2 expiries');
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
    expect(w.requests).toEqual(['5m', '5m', '5m', '5m']);
  });
});

describe('where the raise does nothing', () => {
  test('FORCE_PROMPT_CACHING_5M: never acts, says so in /cache', async ($, on) => {
    const w = world(on, { FORCE_PROMPT_CACHING_5M: '1' });
    await $.session.start(START);
    await w.typed($);
    for (let i = 0; i < 3; i += 1) {
      await w.clock.advance(6 * MIN);
      await w.typed($);
    }
    expect(w.requests).toEqual(['5m', '5m', '5m', '5m']);
    expect(w.sets.filter((s) => s.value === '1h')).toEqual([]);
    expect(await raiseLine($)).toBe('auto-raise inactive: FORCE_PROMPT_CACHING_5M is set');
    expect(await cache($)).toMatch(/ · warning: FORCE_PROMPT_CACHING_5M="1" is set, so every request uses 5m$/);
  });

  test('main already at 1h: never acts', async ($, on) => {
    const w = world(on, { [MAIN]: '1h' });
    await $.session.start(START);
    await w.typed($);
    for (let i = 0; i < 3; i += 1) {
      await w.clock.advance(70 * MIN);
      await w.typed($);
    }
    expect(w.requests).toEqual(['1h', '1h', '1h', '1h']);
    expect(w.sets.filter((s) => s.name === MAIN)).toEqual([]);
    expect(await raiseLine($)).toBe('auto-raise idle: main is 1h');
  });

  for (const initial of [undefined, '5m', '1h']) {
    test(`the sub-agents variable (${initial ?? 'unset'}) is never touched`, async ($, on) => {
      const w = world(on, initial === undefined ? {} : { [AGENTS]: initial });
      await $.session.start(START);
      await w.typed($);
      for (let i = 0; i < 3; i += 1) {
        await w.clock.advance(6 * MIN);
        await w.typed($);
      }
      expect(w.env.get(MAIN)).toBe('1h');
      expect(w.sets.filter((s) => s.name === AGENTS)).toEqual([]);
      expect(w.env.get(AGENTS)).toBe(initial);
    });
  }

  test('a /clear starts the count over, and the last request before it is no expiry', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    expect(await raiseLine($)).toBe('auto-raise counting 0 of 2 expiries');
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 0 of 2 expiries');
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
    expect(w.requests).toEqual(['5m', '5m', '5m', '5m']);
  });

  test('a compaction rewrote the prefix: the wake after it is no expiry', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 0 of 2 expiries');
  });
});

describe('a failed write', () => {
  test('prints the failed, the TTL may be unchanged line, claims no 1h, and asks again at the next expiry', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    w.refused.add(MAIN);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(w.requests).toEqual(['5m', '5m', '5m']);
    expect(await raiseLine($)).toMatch(/^auto-raise failed, the TTL may be unchanged: \S/);
    expect(w.logs.join('\n')).toMatch(/the auto-raise failed, the TTL may be unchanged/);
    expect(await cache($)).toMatch(/^main 5m \(option mainTtl, /);
    w.refused.delete(MAIN);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(w.requests).toEqual(['5m', '5m', '5m', '1h']);
    expect(await raiseLine($)).toBe('auto-raise fired just now');
  });
});

describe('review findings', () => {
  test('F1 a precompute installs nothing: the wake after it is still an expiry', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(30_000);
    await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
  });

  test('F2b a typed /cache main 5m holds across /clear: the raise never overrides it', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await cache($, 'main 5m');
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    for (let i = 0; i < 3; i += 1) {
      await w.clock.advance(6 * MIN);
      await w.typed($);
    }
    expect(w.requests).toEqual(['5m', '5m', '5m', '5m']);
    expect(w.env.get(MAIN)).toBe('5m');
  });

  test('F2a after a fire, /clear keeps main at 1h and /cache says the raise fired', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    for (let i = 0; i < 2; i += 1) {
      await w.clock.advance(6 * MIN);
      await w.typed($);
    }
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    await w.clock.advance(MIN);
    expect(w.env.get(MAIN)).toBe('1h');
    expect(await raiseLine($)).toBe('auto-raise fired 1m ago');
  });

  test('R3 prompt.submit 1ms before the expiry, turn.start 2ms after: the prompt.submit verdict is final, the request goes out at the TTL the note was built on', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(5 * MIN - 1);
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } });
    await w.clock.advance(2);
    await w.turn($, 'go');
    expect(w.requests).toEqual(['5m', '5m', '5m']);
    expect(w.contexts[2]).toBeUndefined();
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
  });

  test('R6 a failed read shows in /cache, and the next wake whose read succeeds takes it away', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    w.reads.fails = true;
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } });
    await $.turn.start({ text: 'go', turnId: 'unread' });
    w.reads.fails = false;
    expect(await raiseLine($)).toMatch(/^auto-raise failed, the TTL may be unchanged: .*env\.get/);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
  });

  test('R7 a compaction whose count restart failed shows in /cache, and the next restart that works takes it away', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    w.clock.fails = true;
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never);
    w.clock.fails = false;
    expect(await raiseLine($)).toMatch(/^auto-raise failed: restarting the count failed: .*clock\.now/);
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never);
    expect(await raiseLine($)).toBe('auto-raise counting 0 of 2 expiries');
  });

  test('R5 a /cache main 5m typed while the raise writes 1h wins: main ends at 5m and /cache never claims the raise', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    w.during.set = async () => {
      await cache($, 'main 5m');
    };
    await w.typed($);
    expect(w.env.get(MAIN)).toBe('5m');
    expect(await raiseLine($)).toBe('auto-raise off: /cache main 5m was typed this session');
    expect(await cache($)).toMatch(/^main 5m \(/);
  });

  test('G4 a prompt.submit whose read failed reached no verdict: turn.start weighs the wake, and it counts', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    w.reads.fails = true;
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } });
    w.reads.fails = false;
    await w.turn($, 'go');
    expect(await raiseLine($)).toBe('auto-raise counting 1 of 2 expiries');
  });

  test('G3 a prompt that did not enter spares no later turn: a self-inject after it is weighed, and raises', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(4 * MIN);
    w.prompts.drop = true;
    await $.prompt.submit({ text: 'blocked', wait: false, origin: { kind: 'composer' } });
    await w.clock.advance(3 * MIN);
    await w.turn($);
    expect(w.requests).toEqual(['5m', '5m', '1h']);
    expect(await raiseLine($)).toBe('auto-raise fired just now');
  });

  test('G2 a count restart that fails after the raise fired leaves /cache saying it fired', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    w.clock.fails = true;
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never);
    w.clock.fails = false;
    expect(await raiseLine($)).toBe('auto-raise fired just now');
  });

  for (const [what, act] of [
    ['a compaction', ($: Engine) => $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)],
    ['a /clear', ($: Engine) => $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)],
  ] as const) {
    test(`G5 ${what} landing while the raise writes 1h leaves the 1h the raise's, and fired`, async ($, on) => {
      const w = world(on);
      await $.session.start(START);
      await w.typed($);
      await w.clock.advance(6 * MIN);
      await w.typed($);
      await w.clock.advance(6 * MIN);
      w.during.set = async () => {
        await act($);
      };
      await w.typed($);
      expect(w.env.get(MAIN)).toBe('1h');
      expect(await raiseLine($)).toBe('auto-raise fired just now');
      expect(await cache($)).toMatch(/^main 1h \(auto-raise, option raiseAfterExpiries/);
    });
  }

  test('G6 a /cache main 5m typed while a /clear reads the clock stands: the restart keeps the lock', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    w.clock.during = async () => {
      await cache($, 'main 5m');
    };
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never);
    expect(await raiseLine($)).toBe('auto-raise off: /cache main 5m was typed this session');
  });

  test('G7 a main request between the prompt and its turn voids the prompt verdict: the turn is weighed on the newer request', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    await w.typed($);
    await w.clock.advance(6 * MIN);
    await w.typed($);
    await w.clock.advance(4 * MIN);
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } });
    const stream = $.turn.step({ turnId: 'between', index: 0, model: 'haiku', messageCount: 1 } as never);
    for (;;) if ((await stream.next()).done) break;
    await w.clock.advance(6 * MIN);
    await w.turn($, 'go');
    expect(w.requests).toEqual(['5m', '5m', '5m', '1h']);
  });
});

