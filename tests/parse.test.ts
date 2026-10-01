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
