import { describe, expect, it } from 'vitest';
import { isMarked, summariesStatus, SUMMARY_HEADER, withMark } from '../plugins/cache-live-control/src/summaries.ts';

const MARK = `${SUMMARY_HEADER}: block`;

describe('withMark', () => {
  it('adds the mark to an empty or unset ANTHROPIC_CUSTOM_HEADERS', () => {
    expect(withMark(undefined, true)).toBe(MARK);
    expect(withMark('', true)).toBe(MARK);
    expect(withMark('  \n', true)).toBe(MARK);
  });

  it('keeps the lines the user set and adds the mark after them', () => {
    expect(withMark('X-Team: a\nX-Env: b', true)).toBe(`X-Team: a\nX-Env: b\n${MARK}`);
    expect(withMark('X-Team: a\r\nX-Env: b\r\n', true)).toBe(`X-Team: a\nX-Env: b\n${MARK}`);
  });

  it('puts the mark once, replacing a line of that name whatever its case or value', () => {
    expect(withMark(MARK, true)).toBe(MARK);
    expect(withMark(`X-Team: a\n${SUMMARY_HEADER.toUpperCase()}:allow\n${MARK}`, true)).toBe(`X-Team: a\n${MARK}`);
  });

  it('removes the mark and nothing else when not blocked', () => {
    expect(withMark(`X-Team: a\n${MARK}\nX-Env: b`, false)).toBe('X-Team: a\nX-Env: b');
    expect(withMark(MARK, false)).toBeUndefined();
    expect(withMark(undefined, false)).toBeUndefined();
    expect(withMark('X-Team: a', false)).toBe('X-Team: a');
  });

  it('gives a value with no line of the mark\'s name back byte for byte when not blocked', () => {
    expect(withMark('X-Team: a\r\n\r\nX-Env: b\r\n', false)).toBe('X-Team: a\r\n\r\nX-Env: b\r\n');
    expect(withMark(' \n', false)).toBe(' \n');
  });

  it('does not take a header that only starts with the name for the mark', () => {
    const other = `${SUMMARY_HEADER}-extra: block`;
    expect(withMark(other, true)).toBe(`${other}\n${MARK}`);
    expect(withMark(other, false)).toBe(other);
  });
});

describe('isMarked', () => {
  it('is true only for a line of the mark\'s name with the value block', () => {
    expect(isMarked(`X-Team: a\n${MARK}`)).toBe(true);
    expect(isMarked(`${SUMMARY_HEADER.toUpperCase()}:   BLOCK`)).toBe(true);
    expect(isMarked(`${SUMMARY_HEADER}: allow`)).toBe(false);
    expect(isMarked(`${SUMMARY_HEADER}-extra: block`)).toBe(false);
    expect(isMarked('X-Team: a')).toBe(false);
    expect(isMarked(undefined)).toBe(false);
    expect(isMarked('')).toBe(false);
  });
});

describe('summariesStatus', () => {
  it('says what is sent, and that a gateway must answer for the switch to save anything', () => {
    expect(summariesStatus(false)).toBe('summaries on');
    expect(summariesStatus(true)).toBe(`summaries off (sends ${MARK}; a gateway must answer them)`);
  });
});
