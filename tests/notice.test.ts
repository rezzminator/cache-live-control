import { describe, expect, it } from 'vitest';
import { forgetsNotice, noticeText, noticeTtl } from '../plugins/cache-live-control/src/notice.ts';

const AUTO_WHY = 'automatic, assumed 1h: the subscription default; an API-key plan runs 5m';
/** A compaction that ran: its result carries no skip. */
const COMPACTED = {};

describe('noticeTtl', () => {
  it('names the main TTL and where it comes from', () => {
    expect(noticeTtl({ main: '5m' }, { main: { value: '5m', via: 'command' } })).toEqual({ ttl: '5m', why: 'set by /cache' });
    expect(noticeTtl({ main: '1h' }, { main: { value: '1h', via: 'option' } })).toEqual({ ttl: '1h', why: 'option mainTtl' });
    expect(noticeTtl({ main: '5m' }, {})).toEqual({ ttl: '5m', why: 'CLAUDE_CODE_PROMPT_CACHE_TTL set outside this plugin' });
    expect(noticeTtl({ enable1h: '1' }, {})).toEqual({ ttl: '1h', why: 'ENABLE_PROMPT_CACHING_1H is set' });
  });

  it('reads only the main chat, never the sub-agents', () => {
    expect(noticeTtl({ main: '1h', agents: '5m' }, {})).toEqual({ ttl: '1h', why: 'CLAUDE_CODE_PROMPT_CACHE_TTL set outside this plugin' });
  });

  it('assumes 1h for an automatic main chat, saying so', () => {
    expect(noticeTtl({}, {})).toEqual({ ttl: '1h', why: AUTO_WHY });
    expect(noticeTtl({ main: '' }, {})).toEqual({ ttl: '1h', why: AUTO_WHY });
  });

  it('says 5m whenever FORCE_PROMPT_CACHING_5M is set, over any variable', () => {
    expect(noticeTtl({ main: '1h', force5m: '1' }, {})).toEqual({ ttl: '5m', why: 'FORCE_PROMPT_CACHING_5M is set' });
    expect(noticeTtl({ force5m: 'true' }, {})).toEqual({ ttl: '5m', why: 'FORCE_PROMPT_CACHING_5M is set' });
  });

  it('ignores a FORCE_PROMPT_CACHING_5M that is off', () => {
    expect(noticeTtl({ main: '1h', force5m: '0' }, {})?.ttl).toBe('1h');
  });

  it('claims nothing for a main variable Claude Code does not take', () => {
    expect(noticeTtl({ main: '2h' }, {})).toBeNull();
  });
});

describe('noticeText', () => {
  it('the 1h note: waits are cheap, writes cost 2x, delegate', () => {
    expect(noticeText({ ttl: '1h', why: 'set by /cache' })).toBe(
      "Prompt cache: this main chat runs on a 1-hour TTL (set by /cache). A wait of up to an hour (a sub-agent's run, a background job) keeps this chat's cache warm, and every token written here costs 2× the base input price at 1h against 1.25× at 5m, so keep this context lean: delegate multi-step work to sub-agents and wait for their returns. A later cache note replaces this one.",
    );
  });

  it('the 5m note: a wait over 5 minutes rewrites the context, keep work here', () => {
    expect(noticeText({ ttl: '5m', why: 'FORCE_PROMPT_CACHING_5M is set' })).toBe(
      "Prompt cache: this main chat runs on a 5-minute TTL (FORCE_PROMPT_CACHING_5M is set). Any wait over 5 minutes (a sub-agent's run, a background job, a scheduled wake-up) lets this chat's cache expire, and the next request writes the whole context again. Do work that fits in this chat yourself; delegate only work too large for it, and never wait, poll or schedule a wake-up more than 5 minutes out expecting the cache to hold. A later cache note replaces this one.",
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
