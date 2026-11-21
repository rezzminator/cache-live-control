import { expect, test } from 'vitest';
import { URL } from 'node:url';
import { resolveKeepwarmOptions } from '../../plugins/cache-live-control/src/options.ts';
const defaults = { enabled: true, minContext: 20000, maxPokes: 4, subagentMinContext: 100000, subagents: true, bad: [] };
test.each([
  [{}, {}, defaults],
  [{ keepwarmSubagents: false }, {}, { ...defaults, subagents: false }],
  [{ keepwarmSubagents: false }, { CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENTS: 'TrUe' }, { ...defaults, subagents: true }],
  [{ keepwarmSubagents: false }, { CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENTS: 'bad' }, { ...defaults, subagents: true, bad: ['CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENTS'] }],
  [{ keepwarmMinContext: 50000 }, { CACHE_LIVE_CONTROL_KEEPWARM_MIN_CONTEXT: '30000' }, { ...defaults, minContext: 30000 }],
  [{}, { CACHE_LIVE_CONTROL_KEEPWARM: 'FALSE' }, { ...defaults, enabled: false }],
  [{ keepwarmMaxPokes: 6 }, {}, { ...defaults, maxPokes: 6 }], [{ keepwarmMaxPokes: 6 }, { CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES: '2' }, { ...defaults, maxPokes: 2 }],
  [{ keepwarmMaxPokes: 6 }, { CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES: '0' }, { ...defaults, bad: ['CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES'] }],
  [{ keepwarmMaxPokes: 0 }, {}, { ...defaults, bad: ['keepwarmMaxPokes'] }], [{ keepwarmMaxPokes: 1.5 }, {}, { ...defaults, bad: ['keepwarmMaxPokes'] }], [{ keepwarmMaxPokes: 1 }, {}, { ...defaults, maxPokes: 1 }],
  [{ keepwarmSubagentMinContext: 50000 }, { CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENT_MIN_CONTEXT: '0' }, { ...defaults, subagentMinContext: 0 }],
  [{}, { CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENT_MIN_CONTEXT: '-1' }, { ...defaults, bad: ['CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENT_MIN_CONTEXT'] }],
  [{}, { CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENTS: '0' }, { ...defaults, subagents: false }],
  [{}, { CACHE_LIVE_CONTROL_KEEPWARM_MIN_CONTEXT: '  ' }, defaults],
  [{ keepwarmSubagentMinContext: '', keepwarmMaxPokes: ' ', keepwarmMinContext: '30000' }, {}, { ...defaults, minContext: 30000 }],
  [{ keepwarm: false, keepwarmMinContext: 1, keepwarmMaxPokes: 1, keepwarmSubagentMinContext: 1 }, {}, { ...defaults, enabled: false, minContext: 1, maxPokes: 1, subagentMinContext: 1 }],
  [{}, { CACHE_LIVE_CONTROL_KEEPWARM_MIN_CONTEXT: '-1', CACHE_LIVE_CONTROL_KEEPWARM: 'yes' }, { ...defaults, bad: ['CACHE_LIVE_CONTROL_KEEPWARM', 'CACHE_LIVE_CONTROL_KEEPWARM_MIN_CONTEXT'] }],
  [{}, { CACHE_LIVE_CONTROL_KEEPWARM_MIN_CONTEXT: '1.5', CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES: 'Infinity' }, { ...defaults, bad: ['CACHE_LIVE_CONTROL_KEEPWARM_MIN_CONTEXT', 'CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES'] }],
] as const)('resolves options %#', (options, env, expected) => {
  let actual: unknown; try { actual = resolveKeepwarmOptions(options, env); } catch (error) { actual = String(error); }
  expect(actual).toEqual(expected);
});

test('installed userConfig matches runtime option defaults and all option names', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../../plugins/cache-live-control/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const { bad, ...runtime } = resolveKeepwarmOptions({}, {});
  const keys = { enabled: 'keepwarm', minContext: 'keepwarmMinContext', maxPokes: 'keepwarmMaxPokes', subagentMinContext: 'keepwarmSubagentMinContext', subagents: 'keepwarmSubagents' };
  expect(Object.fromEntries(Object.entries(keys).map(([field, key]) => [field, manifest.userConfig[key]?.default]))).toEqual(runtime);
});
