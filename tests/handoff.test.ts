import { describe, expect, it } from 'vitest';
import { HANDOFF, startPlan } from '../plugins/cache-live-control/src/handoff.ts';
import type { ResolvedOptions } from '../plugins/cache-live-control/src/options.ts';

const NO_OPTIONS: ResolvedOptions = { errors: [] };
const OPTIONS: ResolvedOptions = { main: '5m', agents: '1h', errors: [] };

describe('startPlan', () => {
  it('names the plugin-owned variables: the options mainTtl and subagentTtl, and the launcher spelling for the sub-agents', () => {
    expect(HANDOFF).toEqual({
      main: ['CACHE_LIVE_CONTROL_MAIN_TTL'],
      agents: ['CACHE_LIVE_CONTROL_SUBAGENT_TTL', 'CACHE_LIVE_CONTROL_AGENTS_TTL'],
    });
  });

  // Per party, the first that is set wins: Claude Code's variable, the handoff variable, the option.
  const MAIN = 'CACHE_LIVE_CONTROL_MAIN_TTL';
  const SUBAGENT = 'CACHE_LIVE_CONTROL_SUBAGENT_TTL';
  const AGENTS = 'CACHE_LIVE_CONTROL_AGENTS_TTL';
  it.each([
    ['the variable set at launch beats the handoff and the option', { main: '1h' }, { [MAIN]: '5m' }, OPTIONS, { agents: '1h' }, { agents: 'option' }],
    ['the handoff beats the option', {}, { [MAIN]: '1h', [SUBAGENT]: '5m' }, OPTIONS, { main: '1h', agents: '5m' }, { main: 'handoff', agents: 'handoff' }],
    ['the option applies without a handoff', {}, {}, OPTIONS, { main: '5m', agents: '1h' }, { main: 'option', agents: 'option' }],
    ['an empty handoff falls through to the option', {}, { [MAIN]: '', [SUBAGENT]: ' ', [AGENTS]: '' }, OPTIONS, { main: '5m', agents: '1h' }, { main: 'option', agents: 'option' }],
    ['a handoff auto leaves the party automatic over the option', {}, { [MAIN]: 'auto' }, OPTIONS, { main: null, agents: '1h' }, { main: 'handoff', agents: 'option' }],
    ['a handoff alone', {}, { [SUBAGENT]: ' 1H ' }, NO_OPTIONS, { agents: '1h' }, { agents: 'handoff' }],
    ['the launcher spelling decides the sub-agents when the option variable is unset', {}, { [AGENTS]: '5m' }, OPTIONS, { main: '5m', agents: '5m' }, { main: 'option', agents: 'handoff' }],
    ['the option variable beats the launcher spelling', {}, { [SUBAGENT]: '1h', [AGENTS]: '5m' }, NO_OPTIONS, { agents: '1h' }, { agents: 'handoff' }],
    ['nothing set, nothing changes', {}, {}, NO_OPTIONS, {}, {}],
  ] as const)('%s', (_name, env, handoff, options, change, via) => {
    expect(startPlan(handoff, options, env)).toEqual({ change, via, errors: [] });
  });

  it('names a bad handoff variable and leaves the party automatic: the option does not stand in', () => {
    expect(startPlan({ [MAIN]: '2h', [SUBAGENT]: 'x' }, OPTIONS, {})).toEqual({
      change: {},
      via: {},
      errors: ['CACHE_LIVE_CONTROL_MAIN_TTL "2h" ignored: use 5m, 1h or auto', 'CACHE_LIVE_CONTROL_SUBAGENT_TTL "x" ignored: use 5m, 1h or auto'],
    });
  });

  it('names a bad launcher-spelling variable the same way', () => {
    expect(startPlan({ [AGENTS]: '3h' }, OPTIONS, {})).toEqual({
      change: { main: '5m' },
      via: { main: 'option' },
      errors: ['CACHE_LIVE_CONTROL_AGENTS_TTL "3h" ignored: use 5m, 1h or auto'],
    });
  });

  it('reports a bad handoff value even when the variable set at launch wins', () => {
    expect(startPlan({ [MAIN]: '2h' }, NO_OPTIONS, { main: '1h' }).errors).toEqual(['CACHE_LIVE_CONTROL_MAIN_TTL "2h" ignored: use 5m, 1h or auto']);
  });
});
