import { expect, test } from 'vitest';
import { metaRow, type LogRow } from '../../plugins/cache-live-control/src/keepwarm/log.ts';
test('a metadata row excludes arbitrary producer secrets', () => {
  const row = { at: 1, event: 'decision', epoch: 0, items: [{ id: 'a', kind: 'agent', label: 'sk-test-123' }], ttl: '5m', ttlSource: 'assumed', context: 50000, spent: 0, reason: 'eligible', secret: 'sk-test-123' } as unknown as LogRow;
  const actual = metaRow(row);
  expect(JSON.stringify(actual)).not.toContain('sk-test-123');
  expect(actual).toEqual({ at: 1, event: 'decision', epoch: 0, items: [{ id: 'a', kind: 'agent' }], ttl: '5m', ttlSource: 'assumed', context: 50000, spent: 0, reason: 'eligible' });
});
test('a row keeps the poke count of its wait, so a reached limit reads in the log', () => {
  const row = { at: 1, event: 'decision', epoch: 0, items: [], ttl: '5m', ttlSource: 'assumed', context: 50000, spent: 0, reason: 'poke-limit', pokes: { count: 4, max: 4, extra: 1 }, stray: '5m' } as unknown as LogRow;
  expect(metaRow(row)).toEqual({ at: 1, event: 'decision', epoch: 0, items: [], ttl: '5m', ttlSource: 'assumed', context: 50000, spent: 0, reason: 'poke-limit', pokes: { count: 4, max: 4 } });
});
test('sub-agent metadata retains identity but never its prompt or label', () => {
  const row = { kind: 'subagent', agentId: 'child', at: 1, event: 'warm', epoch: 2, items: [{ id: 'work', kind: 'command', label: 'secret-label' }], ttl: '5m', ttlSource: 'assumed', context: 50000, spent: 1, text: 'secret-message' } as unknown as LogRow;
  const actual = metaRow(row); expect(actual).toMatchObject({ kind: 'subagent', agentId: 'child' });
  expect(JSON.stringify(actual)).not.toMatch(/secret-label|secret-message/);
});
