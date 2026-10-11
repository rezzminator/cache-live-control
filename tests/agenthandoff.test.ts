import { describe, expect, it } from 'vitest';
import { defaultDir, handoffFile, handoffStatus, instruction, withInstruction } from '../plugins/cache-live-control/src/agenthandoff.ts';

describe('handoffFile', () => {
  it('is the directory plus the spawn id, a safe file name', () => {
    expect(handoffFile('/h', 'toolu_01AbC')).toBe('/h/toolu_01AbC.md');
    expect(handoffFile('/h/', 'toolu_01AbC')).toBe('/h/toolu_01AbC.md');
    expect(handoffFile('/h', 'a/../b c')).toBe('/h/a_.._b_c.md');
  });
});

describe('instruction and withInstruction', () => {
  it('asks for a handoff at the path before the final answer, naming what it holds, and a way out', () => {
    const text = instruction('/h/x.md');
    expect(text).toContain('/h/x.md');
    for (const part of ['final answer', 'state of the work', 'decisions', 'rejected', 'next steps', 'file:line', 'open questions', 'cannot write']) {
      expect(text).toContain(part);
    }
    expect(text).not.toMatch(/professor/i);
  });

  it('appends the instruction after the prompt, leaving the prompt whole', () => {
    expect(withInstruction('do the thing', '/h/x.md')).toBe(`do the thing\n\n${instruction('/h/x.md')}`);
  });
});

describe('defaultDir: inside the plugin\'s own data directory', () => {
  it('derives an installed plugin\'s data directory from its cache root', () => {
    expect(defaultDir({ root: '/h/.claude/plugins/cache/mkt/cache-live-control/0.3.1', name: 'cache-live-control' })).toBe(
      '/h/.claude/plugins/data/cache-live-control-mkt/handoffs',
    );
  });

  it('replaces characters a data directory name does not take', () => {
    expect(defaultDir({ root: '/h/.claude/plugins/cache/my.market/cache-live-control/1.0.0', name: 'cache-live-control' })).toBe(
      '/h/.claude/plugins/data/cache-live-control-my-market/handoffs',
    );
  });

  it('puts an inline plugin under the config directory, else the home\'s .claude', () => {
    expect(defaultDir({ root: '/work/plugins/cache-live-control', name: 'cache-live-control', configDir: '/c' })).toBe('/c/plugins/data/cache-live-control-inline/handoffs');
    expect(defaultDir({ root: '/work/plugins/cache-live-control', name: 'cache-live-control', home: '/h' })).toBe('/h/.claude/plugins/data/cache-live-control-inline/handoffs');
  });

  it('is undefined when neither a cache root nor a config directory or home is known', () => {
    expect(defaultDir({ root: '/work/plugins/cache-live-control', name: 'cache-live-control' })).toBeUndefined();
  });

  it('skips a relative config directory or home: the agent and the plugin would read it against different directories', () => {
    expect(defaultDir({ root: '/work/plugins/cache-live-control', name: 'cache-live-control', configDir: 'cfg', home: '/h' })).toBe('/h/.claude/plugins/data/cache-live-control-inline/handoffs');
    expect(defaultDir({ root: '/work/plugins/cache-live-control', name: 'cache-live-control', home: 'h' })).toBeUndefined();
  });
});

describe('handoffStatus', () => {
  it('shows off, on with its directory, or on without one', () => {
    expect(handoffStatus({ handoff: false })).toBe('handoff off');
    expect(handoffStatus({ handoff: true, dir: '/h' })).toBe('handoff on (/h)');
    expect(handoffStatus({ handoff: true })).toBe('handoff on, no directory: set handoffDir');
  });
});
