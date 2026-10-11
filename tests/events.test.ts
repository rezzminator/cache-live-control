import { describe, expect, it } from 'vitest';
import { ago, formatEvents, pushEvent, span, type Event } from '../plugins/cache-live-control/src/events.ts';

const MIN = 60_000;
const NOW = 1_000 * MIN;

describe('span and ago', () => {
  it('say under a minute, minutes up to two hours, then hours', () => {
    expect(span(30_000)).toBe('under a minute');
    expect(span(23 * MIN)).toBe('23m');
    expect(span(119 * MIN)).toBe('119m');
    expect(span(120 * MIN)).toBe('2h');
    expect(span(5 * 60 * MIN + 59 * MIN)).toBe('5h');
  });

  it('say just now for under a minute', () => {
    expect(ago(10_000)).toBe('just now');
    expect(ago(3 * MIN)).toBe('3m ago');
    expect(ago(3 * 60 * MIN)).toBe('3h ago');
  });
});

describe('pushEvent and formatEvents', () => {
  it('keeps the newest events up to the cap, oldest first, and never changes its input', () => {
    const first: Event[] = [{ at: 1, text: 'a' }];
    const two = pushEvent(first, { at: 2, text: 'b' }, 2);
    expect(two).toEqual([{ at: 1, text: 'a' }, { at: 2, text: 'b' }]);
    expect(pushEvent(two, { at: 3, text: 'c' }, 2)).toEqual([{ at: 2, text: 'b' }, { at: 3, text: 'c' }]);
    expect(first).toEqual([{ at: 1, text: 'a' }]);
  });

  it('lists the newest first, each with its age, and is absent when there are none', () => {
    expect(formatEvents([], NOW)).toBeUndefined();
    const events: Event[] = [
      { at: NOW - 5 * MIN, text: 'raised researcher' },
      { at: NOW - MIN, text: 'blocked a resume of builder' },
    ];
    expect(formatEvents(events, NOW)).toBe('recent: blocked a resume of builder 1m ago; raised researcher 5m ago');
  });

  it('shows the newest four', () => {
    const events: Event[] = [1, 2, 3, 4, 5].map((n) => ({ at: NOW - (6 - n) * MIN, text: `e${n}` }));
    expect(formatEvents(events, NOW)).toBe('recent: e5 1m ago; e4 2m ago; e3 3m ago; e2 4m ago');
  });
});
