import { expect, test } from 'vitest';
import { badTtl, observeTtl, resolveTtl, subagentTtl } from '../../plugins/cache-live-control/src/keepwarm/ttl.ts';
test.each([
  [{ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, '1h', { ttl: '5m', source: 'force-5m' }],
  [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, '5m', { ttl: '1h', source: 'env' }],
  [{}, '1h', { ttl: '1h', source: 'observed' }],
  [{ ENABLE_PROMPT_CACHING_1H: '1' }, null, { ttl: '1h', source: 'env-1h' }],
  [{ CLAUDE_CODE_PROMPT_CACHE_TTL: 'bad' }, null, { ttl: '5m', source: 'assumed' }],
] as const)('TTL priority %#', (env, observed, expected) => {
  let actual: unknown; try { actual = resolveTtl(env, observed); } catch (error) { actual = String(error); }
  expect(actual).toEqual(expected);
});
test.each([
  [{}, { ttl: '5m', source: 'assumed' }], [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, { ttl: '5m', source: 'assumed' }],
  [{ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, { ttl: '1h', source: 'env' }], [{ ENABLE_PROMPT_CACHING_1H: '1' }, { ttl: '1h', source: 'env-1h' }],
  [{ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, { ttl: '5m', source: 'force-5m' }],
  [{ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: 'bad', ENABLE_PROMPT_CACHING_1H: '1' }, { ttl: '1h', source: 'env-1h' }],
] as const)('a sub-agent request writes at the sub-agent TTL, never the chat\'s %#', (env, expected) => {
  let actual: unknown; try { actual = subagentTtl(env); } catch (error) { actual = String(error); }
  expect(actual).toEqual(expected);
});
test.each([
  [280406, 50552, 50552, null], [751316, 29512, 50392, '5m'], [1500000, 49000, 50000, '1h'],
  [3300001, 50000, 50000, null], [329999, 50000, 50000, null], [330000, 45000, 50000, '1h'],
  [3300000, 44999, 50000, '5m'], [400000, 0, 0, null], [400000, NaN, 50000, null],
] as const)('TTL observation %#', (gapMs, read, prevContext, expected) => {
  let actual: unknown; try { actual = observeTtl({ gapMs, read, prevContext }); } catch (error) { actual = String(error); }
  expect(actual).toBe(expected);
});

test.each([
  [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, null, '5m'],
  [{ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m', ENABLE_PROMPT_CACHING_1H: '1' }, '1h', '5m'],
  [{ ENABLE_PROMPT_CACHING_1H: '1' }, '5m', '1h'], [{}, '1h', '1h'],
  [{ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }, '1h', '5m'],
] as const)('sub-agent TTL %#', (env, observed, ttl) => expect((resolveTtl as Function)(env, observed, 'subagent').ttl).toBe(ttl));
test.each([
  [{}, []], [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' }, []], [{ CLAUDE_CODE_PROMPT_CACHE_TTL: ' ' }, []],
  [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '30m' }, ['CLAUDE_CODE_PROMPT_CACHE_TTL="30m" ignored: not 5m or 1h']],
  [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '1H', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: 'bad' }, ['CLAUDE_CODE_PROMPT_CACHE_TTL="1H" ignored: not 5m or 1h', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL="bad" ignored: not 5m or 1h']],
] as const)('a TTL variable Claude Code does not take is named %#', (env, expected) => {
  let actual: unknown; try { actual = badTtl(env); } catch (error) { actual = String(error); }
  expect(actual).toEqual(expected);
});
