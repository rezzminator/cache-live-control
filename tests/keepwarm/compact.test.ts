import { expect, test } from 'vitest';
import { compactFacts, compactOutcome, compactReset } from '../../plugins/cache-live-control/src/keepwarm/compact.ts';
import { Harness } from './stand-in.ts';
test.each([
  [{ trigger: 'auto' }, { trigger: 'auto' }], [{ trigger: 'manual', agentId: 'sub' }, { trigger: 'manual', agentId: 'sub' }],
  [{ trigger: 'precompute', agentId: '' }, { trigger: 'precompute' }], [{}, { trigger: 'unknown' }], [{ trigger: 'later', agentId: 7 }, { trigger: 'unknown' }],
])('compact metadata %# keeps only a known trigger and a real agentId', (input, facts) => expect(compactFacts(input)).toEqual(facts));
test.each([['precompute', 'none', 'none'], ['auto', 'main', 'agent'], ['manual', 'main', 'agent'], ['plugin', 'main', 'agent'], ['unknown', 'main', 'agent']] as const)('a %s compaction resets %s, and from a sub-agent %s', (trigger, main, agent) => {
  expect(compactReset({ trigger })).toBe(main); expect(compactReset({ trigger, agentId: 'sub' })).toBe(agent);
});
test.each([[{}, 'installed'], [undefined, 'installed'], [{ skip: 'vetoed' }, 'skipped'], [{ skip: 1 }, 'installed']] as const)('a compaction answering %j is %s', (result, outcome) => expect(compactOutcome(result)).toBe(outcome));
test.each([['precompute', 'sub', 1], ['auto', 'sub', 1], ['auto', undefined, 0]] as const)('a %s compaction by %s logs its trigger and agentId; %i main warm stays pending', async (trigger, agentId, pending) => {
  const h = new Harness({}, { PLUGIN_LOG_DIR: 'logs' }); await h.arm(); await h.emit('session.compact', { trigger, ...(agentId ? { agentId } : {}), instructions: 'secret focus', messages: [] }); expect(h.pending).toHaveLength(pending); expect(h.rows().filter((r: any) => r.event === 'compact')).toMatchObject([{ trigger, ...(agentId ? { agentId } : {}) }]); expect(JSON.stringify(h.rows())).not.toContain('secret focus'); });
test.each([[{}, 'installed'], [{ skip: 'below the threshold' }, 'skipped']] as const)('a compaction answering %j logs its outcome %s', async (result, outcome) => {
  const h = new Harness({}, { PLUGIN_LOG_DIR: 'logs' }); await h.arm(); const done = await h.emit('session.compact', { trigger: 'auto', messages: [] }, result); expect(done.result).toBe(result); expect(h.rows().filter((r: any) => r.event === 'compact')).toMatchObject([{ trigger: 'auto', outcome }]); });
test('a failing compaction logs outcome failed and rethrows', async () => {
  const h = new Harness({}, { PLUGIN_LOG_DIR: 'logs' }); await h.arm(); const fn = h.handlers.get('session.compact')![0]!.fn;
  await expect(fn(h.engine, { trigger: 'auto', messages: [] }, async () => { throw new Error('summarizer down'); })).rejects.toThrow('summarizer down'); expect(h.rows().filter((r: any) => r.event === 'compact')).toMatchObject([{ trigger: 'auto', outcome: 'failed' }]); });
