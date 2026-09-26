import { describe, expect, it } from 'vitest';
import { optionChange, resolveOptions } from '../plugins/cache-live-control/src/options.ts';

describe('resolveOptions', () => {
  it('takes 5m and 1h for each party', () => {
    expect(resolveOptions({ mainTtl: '5m', subagentTtl: '1h' })).toEqual({ main: '5m', agents: '1h', errors: [] });
  });

  it('leaves a party automatic when its option is empty or missing', () => {
    expect(resolveOptions({ mainTtl: '', subagentTtl: '' })).toEqual({ errors: [] });
    expect(resolveOptions({})).toEqual({ errors: [] });
  });

  it('trims and lowercases', () => {
    expect(resolveOptions({ mainTtl: ' 1H ' })).toEqual({ main: '1h', errors: [] });
  });

  it('ignores a bad value, naming the option and the value', () => {
    expect(resolveOptions({ mainTtl: '2h', subagentTtl: 'auto' })).toEqual({
      errors: ['option mainTtl "2h" ignored: use 5m, 1h or empty', 'option subagentTtl "auto" ignored: use 5m, 1h or empty'],
    });
  });

  it('ignores a value that is not a string', () => {
    expect(resolveOptions({ mainTtl: 5, subagentTtl: true })).toEqual({
      errors: ['option mainTtl 5 ignored: use 5m, 1h or empty', 'option subagentTtl true ignored: use 5m, 1h or empty'],
    });
  });

  it('keeps a good option beside a bad one', () => {
    expect(resolveOptions({ mainTtl: '5m', subagentTtl: 'x' })).toEqual({ main: '5m', errors: ['option subagentTtl "x" ignored: use 5m, 1h or empty'] });
  });
});

describe('optionChange', () => {
  it('sets each party that has an option and an unset variable', () => {
    expect(optionChange({ main: '5m', agents: '1h', errors: [] }, {})).toEqual({ main: '5m', agents: '1h' });
    expect(optionChange({ main: '5m', errors: [] }, { main: '' })).toEqual({ main: '5m' });
  });

  it('leaves a party whose variable is already set', () => {
    expect(optionChange({ main: '5m', agents: '1h', errors: [] }, { main: '1h' })).toEqual({ agents: '1h' });
  });

  it('changes nothing without options', () => {
    expect(optionChange({ errors: [] }, {})).toEqual({});
  });
});
