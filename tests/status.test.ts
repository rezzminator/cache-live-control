import { describe, expect, it } from 'vitest';
import { formatState, formatStatus, isForced5m, resolveParty, type Ours } from '../plugins/cache-live-control/src/status.ts';

const NONE: Ours = {};

describe('resolveParty', () => {
  it('is automatic when the variable is unset or empty', () => {
    const automatic = { ttl: 'automatic', source: 'settings, agent frontmatter or plan default' };
    expect(resolveParty('main', {}, NONE)).toEqual(automatic);
    expect(resolveParty('agents', { agents: '' }, NONE)).toEqual(automatic);
  });

  it('credits /cache when the variable holds what the command set', () => {
    expect(resolveParty('main', { main: '5m' }, { main: { value: '5m', via: 'command' } })).toEqual({ ttl: '5m', source: 'set by /cache' });
  });

  it('credits the option by name when the variable holds what the option set', () => {
    expect(resolveParty('main', { main: '1h' }, { main: { value: '1h', via: 'option' } })).toEqual({ ttl: '1h', source: 'option mainTtl' });
    expect(resolveParty('agents', { agents: '5m' }, { agents: { value: '5m', via: 'option' } })).toEqual({ ttl: '5m', source: 'option subagentTtl' });
  });

  it('names the variable when it was set outside the plugin', () => {
    expect(resolveParty('main', { main: '1h' }, NONE)).toEqual({ ttl: '1h', source: 'CLAUDE_CODE_PROMPT_CACHE_TTL set outside this plugin' });
    expect(resolveParty('agents', { agents: '5m' }, NONE)).toEqual({ ttl: '5m', source: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL set outside this plugin' });
  });

  it('names the variable when it changed since the plugin set it', () => {
    expect(resolveParty('main', { main: '1h' }, { main: { value: '5m', via: 'command' } }).source).toBe('CLAUDE_CODE_PROMPT_CACHE_TTL set outside this plugin');
  });

  it('flags a value Claude Code does not take', () => {
    expect(resolveParty('agents', { agents: '30m' }, NONE)).toEqual({ ttl: 'unknown', source: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL="30m" is not 5m or 1h' });
  });
});

describe('isForced5m', () => {
  it('is set for any value but empty or an off word', () => {
    expect(isForced5m('1')).toBe(true);
    expect(isForced5m('true')).toBe(true);
    expect(isForced5m(undefined)).toBe(false);
    expect(isForced5m('')).toBe(false);
    expect(isForced5m(' ')).toBe(false);
    for (const off of ['0', 'false', 'FALSE', 'no', 'off']) expect(isForced5m(off)).toBe(false);
  });
});

describe('formatStatus', () => {
  it('lists each party with its source on one line', () => {
    expect(formatStatus({ main: '5m' }, { main: { value: '5m', via: 'command' } })).toBe(
      'main 5m (set by /cache) · agents automatic (settings, agent frontmatter or plan default)',
    );
  });

  it('warns when FORCE_PROMPT_CACHING_5M is set', () => {
    expect(formatStatus({ force5m: '1' }, NONE)).toBe(
      'main automatic (settings, agent frontmatter or plan default) · agents automatic (settings, agent frontmatter or plan default) · warning: FORCE_PROMPT_CACHING_5M="1" is set, so every request uses 5m',
    );
  });

  it('carries the ignored options', () => {
    expect(formatStatus({}, NONE, ['option mainTtl "2h" ignored: use 5m, 1h or empty'])).toMatch(/ · option mainTtl "2h" ignored: use 5m, 1h or empty$/);
  });
});

describe('formatState', () => {
  it('states each party TTL only', () => {
    expect(formatState({ main: '5m', agents: '1h' }, NONE)).toBe('main 5m · agents 1h');
    expect(formatState({}, NONE)).toBe('main automatic · agents automatic');
  });

  it('keeps the FORCE_PROMPT_CACHING_5M warning', () => {
    expect(formatState({ main: '1h', force5m: 'yes' }, NONE)).toBe('main 1h · agents automatic · warning: FORCE_PROMPT_CACHING_5M="yes" is set, so every request uses 5m');
  });
});
