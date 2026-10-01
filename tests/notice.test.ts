import { describe, expect, it } from 'vitest';
import { forgetsNotice, noticeText, noticeTtl } from '../plugins/cache-live-control/src/notice.ts';

/** A compaction that ran: its result carries no skip. */
const COMPACTED = {};

describe('noticeTtl', () => {
  it('names the main TTL from wherever it comes', () => {
    expect(noticeTtl({ main: '5m' }, { main: { value: '5m', via: 'command' } })).toBe('5m');
    expect(noticeTtl({ main: '1h' }, { main: { value: '1h', via: 'option' } })).toBe('1h');
    expect(noticeTtl({ main: '5m' }, {})).toBe('5m');
    expect(noticeTtl({ enable1h: '1' }, {})).toBe('1h');
  });

  it('reads only the main chat, never the sub-agents', () => {
    expect(noticeTtl({ main: '1h', agents: '5m' }, {})).toBe('1h');
  });

  it('assumes 1h for an automatic main chat', () => {
    expect(noticeTtl({}, {})).toBe('1h');
    expect(noticeTtl({ main: '' }, {})).toBe('1h');
  });

  it('says 5m whenever FORCE_PROMPT_CACHING_5M is set, over any variable', () => {
    expect(noticeTtl({ main: '1h', force5m: '1' }, {})).toBe('5m');
    expect(noticeTtl({ force5m: 'true' }, {})).toBe('5m');
  });

  it('ignores a FORCE_PROMPT_CACHING_5M that is off', () => {
    expect(noticeTtl({ main: '1h', force5m: '0' }, {})).toBe('1h');
  });

  it('claims nothing for a main variable Claude Code does not take', () => {
    expect(noticeTtl({ main: '2h' }, {})).toBeNull();
  });
});

describe('noticeText', () => {
  it('the 1h note orders delegation past about 10 tool calls', () => {
    expect(noticeText('1h')).toBe(
      "Prompt cache: this chat's cache lives 1 hour. Delegate: hand any task that needs more than about 10 tool calls to a sub-agent and wait for its return; do only quick reads, answers and small edits yourself. Waiting is free on a 1-hour cache and every token this chat writes costs double, so this overrides any default to do mid-size work directly.",
    );
  });

  it('the 5m note orders direct work and waits under 4 minutes', () => {
    expect(noticeText('5m')).toBe(
      "Prompt cache: this chat's cache lives 5 minutes. Work directly: do the task here with your own tool calls. A sub-agent run, background job or wait longer than about 4 minutes expires this chat's cache and forces a full rewrite of its context, so delegate only work that cannot fit in this chat, and keep every wait under 4 minutes.",
    );
  });
});

describe('forgetsNotice', () => {
  it('a main-chat compaction that ran forgets the note', () => {
    expect(forgetsNotice({}, COMPACTED)).toBe(true);
  });

  it("a sub-agent's compaction leaves it", () => {
    expect(forgetsNotice({ agentId: 'a1' }, COMPACTED)).toBe(false);
  });

  it('a skipped compaction leaves it', () => {
    expect(forgetsNotice({}, { skip: 'blocked' })).toBe(false);
  });
});
