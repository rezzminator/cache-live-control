import { describe, expect, it } from 'vitest';
import { HANDOFF, startPlan } from '../plugins/cache-live-control/src/handoff.ts';
import type { ResolvedOptions } from '../plugins/cache-live-control/src/options.ts';

const NO_OPTIONS: ResolvedOptions = { errors: [] };
const OPTIONS: ResolvedOptions = { main: '5m', agents: '1h', errors: [] };

describe('startPlan', () => {
  it('names the two plugin-owned variables', () => {
    expect(HANDOFF).toEqual({ main: 'CACHE_LIVE_CONTROL_MAIN_TTL', agents: 'CACHE_LIVE_CONTROL_AGENTS_TTL' });
  });

  // Per party, the first that is set wins: Claude Code's variable, the handoff, the option.
  it.each([
    ['the variable set at launch beats the handoff and the option', { main: '1h' }, { main: '5m' }, OPTIONS, { agents: '1h' }, { agents: 'option' }],
    ['the handoff beats the option', {}, { main: '1h', agents: '5m' }, OPTIONS, { main: '1h', agents: '5m' }, { main: 'handoff', agents: 'handoff' }],
    ['the option applies without a handoff', {}, {}, OPTIONS, { main: '5m', agents: '1h' }, { main: 'option', agents: 'option' }],
    ['an empty handoff falls through to the option', {}, { main: '', agents: ' ' }, OPTIONS, { main: '5m', agents: '1h' }, { main: 'option', agents: 'option' }],
    ['a handoff auto leaves the party automatic over the option', {}, { main: 'auto' }, OPTIONS, { main: null, agents: '1h' }, { main: 'handoff', agents: 'option' }],
    ['a handoff alone', {}, { agents: ' 1H ' }, NO_OPTIONS, { agents: '1h' }, { agents: 'handoff' }],
    ['nothing set, nothing changes', {}, {}, NO_OPTIONS, {}, {}],
  ] as const)('%s', (_name, env, handoff, options, change, via) => {
    expect(startPlan(handoff, options, env)).toEqual({ change, via, errors: [] });
  });

  it('ignores a bad handoff value by name, falling through to the option', () => {
    expect(startPlan({ main: '2h', agents: 'x' }, { main: '5m', errors: [] }, {})).toEqual({
      change: { main: '5m' },
      via: { main: 'option' },
      errors: ['CACHE_LIVE_CONTROL_MAIN_TTL "2h" ignored: use 5m, 1h or auto', 'CACHE_LIVE_CONTROL_AGENTS_TTL "x" ignored: use 5m, 1h or auto'],
    });
  });

  it('reports a bad handoff value even when the variable set at launch wins', () => {
    expect(startPlan({ main: '2h' }, NO_OPTIONS, { main: '1h' }).errors).toEqual(['CACHE_LIVE_CONTROL_MAIN_TTL "2h" ignored: use 5m, 1h or auto']);
  });
});
