import { describe, expect, it } from 'vitest';
import { parseArgs, USAGE } from '../plugins/cache-live-control/src/parse.ts';

describe('parseArgs', () => {
  it('reads no arguments, or only spaces, as status', () => {
    expect(parseArgs('')).toEqual({ kind: 'status' });
    expect(parseArgs('   ')).toEqual({ kind: 'status' });
  });

  it('sets both parties from a bare TTL', () => {
    expect(parseArgs('5m')).toEqual({ kind: 'set', change: { main: '5m', agents: '5m' } });
    expect(parseArgs('1h')).toEqual({ kind: 'set', change: { main: '1h', agents: '1h' } });
  });

  it('unsets both parties on auto', () => {
    expect(parseArgs('auto')).toEqual({ kind: 'set', change: { main: null, agents: null } });
  });

  it('sets only the main chat after main', () => {
    expect(parseArgs('main 5m')).toEqual({ kind: 'set', change: { main: '5m' } });
    expect(parseArgs('main 1h')).toEqual({ kind: 'set', change: { main: '1h' } });
    expect(parseArgs('main auto')).toEqual({ kind: 'set', change: { main: null } });
  });

  it('sets only the sub-agents after agents', () => {
    expect(parseArgs('agents 5m')).toEqual({ kind: 'set', change: { agents: '5m' } });
    expect(parseArgs('agents 1h')).toEqual({ kind: 'set', change: { agents: '1h' } });
    expect(parseArgs('agents auto')).toEqual({ kind: 'set', change: { agents: null } });
  });

  it('ignores case and extra spaces', () => {
    expect(parseArgs('  MAIN   1H ')).toEqual({ kind: 'set', change: { main: '1h' } });
    expect(parseArgs('Auto')).toEqual({ kind: 'set', change: { main: null, agents: null } });
  });

  it.each([
    ['30m'],
    ['1d'],
    ['main'],
    ['agents'],
    ['main 30m'],
    ['agents 2h'],
    ['subagents 5m'],
    ['5m main'],
    ['main 5m extra'],
    ['main agents 5m'],
    ['both 1h'],
  ])('refuses %j with the usage, changing nothing', (args) => {
    const action = parseArgs(args);
    expect(action).toEqual({ kind: 'error', message: `nothing changed, "${args}" is not understood; ${USAGE}` });
  });

  it('keeps the error to one line', () => {
    const action = parseArgs('x');
    expect(action.kind).toBe('error');
    if (action.kind === 'error') expect(action.message).not.toContain('\n');
  });
});
