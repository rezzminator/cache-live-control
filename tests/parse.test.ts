import { describe, expect, it } from 'vitest';
import { parseArgs, USAGE } from '../plugins/cache-live-control/src/parse.ts';
import type { Change } from '../plugins/cache-live-control/src/ttl.ts';

const BOTH_1H: Change = { main: '1h', agents: '1h' };
const SPLIT: Change = { main: '1h', agents: '5m' };

describe('parseArgs', () => {
  it('reads no arguments or only spaces as status', () => {
    expect(parseArgs('')).toEqual({ kind: 'status' });
    expect(parseArgs('   ')).toEqual({ kind: 'status' });
  });

  it.each<[string, Change]>([
    ['5m', { main: '5m', agents: '5m' }],
    ['auto', { main: null, agents: null }],
    ['main 1h', { main: '1h' }],
    ['1h main', { main: '1h' }],
    ['main auto', { main: null }],
    ['agents 5m', { agents: '5m' }],
    ['5m agents', { agents: '5m' }],
    ['agent 5m', { agents: '5m' }],
    ['5m sub-agents', { agents: '5m' }],
    ['subagents 1h', { agents: '1h' }],
    ['main agents 1h', BOTH_1H],
    ['1h main agents', BOTH_1H],
    ['1h agents main', BOTH_1H],
    ['both 1h', BOTH_1H],
    ['1h all', BOTH_1H],
    ['main 1h agents 5m', SPLIT],
    ['1h main 5m agents', SPLIT],
    ['agents 5m main 1h', SPLIT],
    ['main 1h, agents 5m', SPLIT],
    ['main 1h,agents 5m', SPLIT],
    ['main main 1h', { main: '1h' }],
    ['  MAIN   1H ', { main: '1h' }],
  ])('parses %j', (args, change) => {
    expect(parseArgs(args)).toEqual({ kind: 'set', change });
  });

  it.each([
    ['main', 'main has no TTL'],
    ['1h 5m', '1h and 5m have no party between them'],
    ['main 1h main 5m', 'main is given twice'],
    ['agents 1h main', 'main has no TTL'],
    ['1h main agents 5m', '5m names no party'],
    ['both 1h main 5m', 'main is given twice'],
    ['7m', '"7m" is not 5m, 1h, auto, main or agents'],
    ['main banana 1h', '"banana" is not 5m, 1h, auto, main or agents'],
  ])('refuses %j, changing nothing', (args, reason) => {
    expect(parseArgs(args)).toEqual({ kind: 'error', message: `nothing changed: ${reason}; ${USAGE}` });
  });

  it('keeps the error and the usage to one line', () => {
    const action = parseArgs('x');
    expect(action.kind).toBe('error');
    if (action.kind === 'error') expect(action.message).not.toContain('\n');
    expect(USAGE).not.toContain('\n');
  });
});

import type { Settings } from '../plugins/cache-live-control/src/parse.ts';

const AMBIGUOUS = (setting: string) => {
  const party = setting.split(' ')[0];
  return `"${setting}" is a setting, so ${party} is no party of the TTL beside it: name the TTL's party next to the TTL, e.g. ${party} 1h ${setting} …`;
};

describe('settings words: thresholds set live', () => {
  it.each<[string, Settings]>([
    ['raise 3', { raise: 3 }],
    ['raise off', { raise: null }],
    ['main raise 2', { raise: 2 }],
    ['guard block', { guard: 'block' }],
    ['guard warn', { guard: 'warn' }],
    ['guard off', { guard: 'off' }],
    ['guard floor 80k', { guardFloor: 80_000 }],
    ['guard floor 45000', { guardFloor: 45_000 }],
    ['guard floor 0', { guardFloor: 0 }],
    ['guard price 15', { guardPrice: 15 }],
    ['guard price 2.5', { guardPrice: 2.5 }],
    ['guard price off', { guardPrice: null }],
    ['summaries off', { summaries: 'off' }],
    ['SUMMARIES ON', { summaries: 'on' }],
  ])('parses %j as a setting with no TTL change', (args, settings) => {
    expect(parseArgs(args)).toEqual({ kind: 'set', change: {}, settings });
  });

  it.each<[string, Change, Settings]>([
    ['guard block main 1h', { main: '1h' }, { guard: 'block' }],
    ['main 1h guard block', { main: '1h' }, { guard: 'block' }],
    ['raise 3 agents 5m summaries off main 1h', { agents: '5m', main: '1h' }, { raise: 3, summaries: 'off' }],
    ['5m, guard warn, guard floor 30k', { main: '5m', agents: '5m' }, { guard: 'warn', guardFloor: 30_000 }],
    ['raise 2 raise 2', {}, { raise: 2 }],
  ])('mixes settings with TTL groups in any order: %j', (args, change, settings) => {
    expect(parseArgs(args)).toEqual({ kind: 'set', change, settings });
  });

  it('leaves the plain TTL forms with no settings key', () => {
    expect(parseArgs('main 1h')).toEqual({ kind: 'set', change: { main: '1h' } });
  });

  it.each([
    ['raise', 'raise needs a whole number of 1 or more, or off'],
    ['raise 0', 'raise needs a whole number of 1 or more, or off'],
    ['raise two', 'raise needs a whole number of 1 or more, or off'],
    ['raise 2.5', 'raise needs a whole number of 1 or more, or off'],
    ['guard', 'guard needs off, warn, block, floor N or price N'],
    ['guard loud', 'guard needs off, warn, block, floor N or price N'],
    ['guard floor', 'guard floor needs a number of tokens such as 60000 or 60k'],
    ['guard floor -1', 'guard floor needs a number of tokens such as 60000 or 60k'],
    ['guard floor lots', 'guard floor needs a number of tokens such as 60000 or 60k'],
    ['guard price', 'guard price needs a number (USD per million input tokens) or off'],
    ['guard price 0', 'guard price needs a number (USD per million input tokens) or off'],
    ['summaries', 'summaries needs on or off'],
    ['summaries maybe', 'summaries needs on or off'],
    ['summaries on summaries off', 'summaries is given twice'],
    ['raise 2 raise 3', 'raise is given twice'],
    ['guard warn guard block', 'guard is given twice'],
    ['raise 3 agents', 'agents has no TTL'],
    // A party word read as the key of a setting is no party of a TTL beside it: never widened to both parties.
    ['1h main raise 2', AMBIGUOUS('main raise')],
    ['main raise 2 1h', AMBIGUOUS('main raise')],
  ])('refuses %j, changing nothing', (args, reason) => {
    expect(parseArgs(args)).toEqual({ kind: 'error', message: `nothing changed: ${reason}; ${USAGE}` });
  });

  it('names the settings in the usage', () => {
    expect(USAGE).toMatch(/raise N\|off/);
    expect(USAGE).toMatch(/guard off\|warn\|block/);
    expect(USAGE).toMatch(/summaries on\|off/);
  });
});
