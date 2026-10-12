import { describe, expect, test } from 'claude-code/testing';
import { cache, START, world } from '../world.ts';

// Run by scripts/test-hook-variants.sh with the manifest default summaries=block.

const HEADERS = 'ANTHROPIC_CUSTOM_HEADERS';
const MARK = 'x-cache-live-control-summaries: block';

describe('the summaries option', () => {
  test('marks the requests at session start, keeping the user\'s own header lines, and /cache says so', async ($, on) => {
    const w = world(on, { [HEADERS]: 'X-Team: a' });
    await $.session.start(START);
    expect(w.env.get(HEADERS)).toBe(`X-Team: a\n${MARK}`);
    expect(await cache($)).toContain(` · summaries off (sends ${MARK}; a gateway must answer them)`);
  });

  test('a refused write at session start is named by /cache, which claims no mark', async ($, on) => {
    const w = world(on);
    w.refused.add(HEADERS);
    await $.session.start(START);
    const text = await cache($);
    expect(text).toContain(' · summaries on');
    expect(text).toMatch(/ · option summaries block: marking the requests failed, they are not marked: [^·]+$/);
  });

  test('/cache summaries on takes the mark away, and off puts it back', async ($, on) => {
    const w = world(on);
    await $.session.start(START);
    expect(w.env.get(HEADERS)).toBe(MARK);
    expect(await cache($, 'summaries on')).toBe('summaries on');
    expect(w.env.has(HEADERS)).toBe(false);
    expect(await cache($, 'summaries off')).toContain('summaries off (');
    expect(w.env.get(HEADERS)).toBe(MARK);
  });
});
