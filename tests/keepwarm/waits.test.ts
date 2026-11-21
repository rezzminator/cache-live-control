import { expect, test } from 'vitest';
import { warmReceipt, ownedFromTool, firstSeen, fromStop, reconcile, sanitizeLabel, type TaskSummary } from '../../plugins/cache-live-control/src/keepwarm/waits.ts';
function call<T>(fn: () => T): T | string { try { return fn(); } catch (error) { return String(error); } }
test('snapshot forms and sanitized producer labels', () => {
  const tasks = [
    { id: 'a46e2aabaedd0967e', type: 'subagent', status: 'running', description: 'Cache experiment long background probe' },
    { id: 'bnlqavl3a', type: 'shell', status: 'running', description: 'probe', command: `python3 -c 'import time; time.sleep(755); print("LONG_PROBE_DONE")'` },
    { id: 'm', type: 'monitor', status: 'running', description: 'watch' },
    { id: 'w', type: 'workflow', status: 'running', description: 'flow' },
    { id: 'u', type: 'future', status: 'running', description: 'unknown' },
    { id: 'd', type: 'subagent', status: 'completed', description: 'done' },
  ] as TaskSummary[];
  expect(call(() => fromStop(tasks, 1))).toEqual({ known: true, items: [
    { id: 'a46e2aabaedd0967e', kind: 'agent', label: 'Cache experiment long background probe' },
    { id: 'bnlqavl3a', kind: 'command', label: `python3 -c 'import time; time.sleep(755)…` },
    { id: 'm', kind: 'monitor', label: 'watch' }, { id: 'w', kind: 'workflow', label: 'flow' },
    { id: 'u', kind: 'future', label: 'unknown' },
  ], ended: [{ item: { id: 'd', kind: 'agent', label: 'done' }, ended: 'completed' }] });
  expect(call(() => fromStop(undefined, 0))).toEqual({ known: false, items: [] });
  expect(call(() => fromStop([], 0))).toEqual({ known: true, items: [] });
  expect(call(() => sanitizeLabel('a\u0007b\n\n  c' + 'x'.repeat(60)))).toBe('ab cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…');
  expect(call(() => sanitizeLabel('\u001b[31mred\u001b[0m'))).toBe('[31mred[0m');
});
test('terminal refinement and independent first-seen times', () => {
  const items = [{ id: 'a', kind: 'agent', label: 'X' }, { id: 'b', kind: 'command', label: 'Y' }];
  for (const status of ['killed', 'completed', 'failed'] as const) {
    expect(call(() => reconcile(items, [{ id: 'a', status }]))).toEqual({ items: [items[1]], ended: [{ item: items[0], ended: status }] });
  }
  for (const status of ['pending', 'running', 'waiting', 'idle'] as const) expect(call(() => reconcile(items, [{ id: 'a', status }]))).toEqual({ items, ended: [] });
  expect(call(() => reconcile(items, []))).toEqual({ items, ended: [] });
  for (const status of ['idle', undefined] as const) expect(reconcile(items, status ? [{ id: 'a', status }] : [], true).items).toEqual([items[1]]);
  for (const status of ['pending', 'running', 'waiting'] as const) expect(reconcile(items, [{ id: 'a', status }], true).items).toEqual(items);
  expect(call(() => firstSeen(items, new Map([['a', 1], ['gone', 2]]), 3))).toEqual(new Map([['a', 1], ['b', 3]]));
});

test.each([
  ['Bash', { command: 'sleep 540' }, { backgroundTaskId: 'shell' }, { id: 'shell', kind: 'command', label: 'sleep 540' }],
  ['Agent', { description: 'Audit' }, { status: 'async_launched', agentId: 'child' }, { id: 'child', kind: 'agent', label: 'Audit' }],
  ['Agent', {}, { agentId: 'child' }, { id: 'child', kind: 'agent', label: 'your background work' }],
  ['Monitor', {}, { taskId: 'watch', timeoutMs: 0 }, { id: 'watch', kind: 'monitor', label: 'Monitor' }],
  ['Workflow', {}, { taskId: 'flow', workflowName: 'Checks', status: 'async_launched' }, { id: 'flow', kind: 'workflow', label: 'Checks' }],
  ['Skill', {}, { background: true, agentId: 'skill' }, { id: 'skill', kind: 'agent', label: 'your background work' }],
  ['Bash', {}, { backgroundTaskId: 'quiet', backgroundEndsWithFinalResponse: true }, null],
  ['Agent', {}, { status: 'completed', agentId: 'done' }, null], ['Bash', {}, null, null],
] as const)('owned background producer %#', (tool, input, result, expected) => expect(ownedFromTool(tool, input, result)).toEqual(expected));

test.each(['raw', 'wrapped', 'foreign', 'tools', 'empty'])('poke receipt %s uses a local expected send, not claimed plugin origin; tools may follow it', kind => {
  const expected = 'Keep-warm poke 1/4: fixed';
  const messages = kind === 'empty' ? [] : [{ role: 'user', text: kind === 'wrapped' ? `The coordinator sent a message while you were working:\n${expected}\n\nAddress this before completing your current task.` : expected, toolUses: [] }, ...(kind === 'foreign' ? [{ role: 'user', text: 'Changed', toolUses: [] }] : []), { role: 'assistant', text: 'K', toolUses: kind === 'tools' ? [{}] : [] }];
  expect(warmReceipt(messages, expected)).toEqual({ own: !['foreign', 'empty'].includes(kind) });
});
