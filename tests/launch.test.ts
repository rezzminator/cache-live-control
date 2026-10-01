import { describe, expect, it } from 'vitest';
import { isEnvTruthy, launchChange } from '../plugins/cache-live-control/src/launch.ts';

describe('isEnvTruthy', () => {
  it('takes 1, true, yes and on, in any case and padding', () => {
    for (const on of ['1', 'true', 'TRUE', ' yes ', 'On']) expect(isEnvTruthy(on)).toBe(true);
  });

  it('refuses unset, empty, off words and anything else', () => {
    for (const off of [undefined, '', ' ', '0', 'false', 'no', 'off', '2', '1h']) expect(isEnvTruthy(off)).toBe(false);
  });
});

describe('launchChange', () => {
  it('moves a launch ENABLE_PROMPT_CACHING_1H to the main chat and takes it from the sub-agents', () => {
    expect(launchChange({ enable1h: '1' })).toEqual({ main: '1h', unsetEnable1h: true });
    expect(launchChange({ enable1h: '1', main: '' })).toEqual({ main: '1h', unsetEnable1h: true });
  });

  it('keeps a main variable already set, and still takes the 1h from the sub-agents', () => {
    expect(launchChange({ enable1h: '1', main: '5m' })).toEqual({ unsetEnable1h: true });
  });

  it('leaves a sub-agent variable to itself', () => {
    expect(launchChange({ enable1h: 'true', agents: '1h' })).toEqual({ main: '1h', unsetEnable1h: true });
  });

  it('leaves the main chat to a launcher handoff that already chose it, and still takes the 1h from the sub-agents', () => {
    expect(launchChange({ enable1h: '1' }, true)).toEqual({ unsetEnable1h: true });
  });

  it('changes nothing when ENABLE_PROMPT_CACHING_1H is unset or off', () => {
    expect(launchChange({})).toEqual({ unsetEnable1h: false });
    expect(launchChange({ enable1h: '0' })).toEqual({ unsetEnable1h: false });
  });
});
