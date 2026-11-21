import { expect, test } from 'vitest';
import { Harness, pokeText as poke } from './stand-in.ts';
const sub = { keepwarmSubagentMinContext: 20000 };
test('sub-agent poke is addressed, attributable, independent, re-anchored and privately accounted', async () => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait();
  expect(h.pending).toHaveLength(1); h.draft = 'user typing'; await h.emit('prompt.edit'); await h.emit('turn.start', { turnId: 'main', text: 'Continue' }); await h.step();
  await h.advance(240000); expect(h.sends).toEqual([{ to: { agentId: 'sub' }, text: poke('1/4', '- command `work-sub`: sleep 540, pending 4m') }]);
  expect(h.submits).toHaveLength(0); await h.warmReply(); expect(h.pending[0]?.at).toBe(h.now + 240000);
  expect((await h.command('status')).text).toContain('sub-agents 1'); expect((await h.command('status')).text).toContain('sleep 540: 1 warms, pokes 1/4');
  const rows = h.rows().filter((r: any) => r.kind === 'subagent' && r.event === 'warm'); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ agentId: 'sub', spent: 6628.5, warms: 1 }); expect(JSON.stringify(rows)).not.toContain('sleep');
  await h.emit('session.receive', { agentId: 'sub', text: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } });
  expect(h.pending).toHaveLength(0); await h.advance(300000); expect(h.sends).toHaveLength(1);
});
test('sub-agents are poked by default above the 100k sub-agent minimum, and never below it', async () => {
  const small = new Harness({}, { PLUGIN_LOG_DIR: 'logs' }); await small.start(); await small.agentWait(); await small.advance(300000);
  expect(small.sends).toHaveLength(0); expect(small.rows().some((r: any) => r.kind === 'subagent' && r.reason === 'small')).toBe(true);
  const h = new Harness(); await h.start(); await h.agentWait('sub', true, 120000); await h.advance(240000); expect(h.sends).toHaveLength(1);
});
test('the sub-agent cap stops at N pokes and shows in /keepwarm; a foreign turn resets it', async () => {
  const h = new Harness(sub, { CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES: '1' }); await h.start(); await h.agentWait(); await h.advance(240000); await h.warmReply();
  expect(h.pending).toHaveLength(0); expect((await h.command('status')).text).toContain('poke limit reached 1/1');
  await h.advance(600000); expect(h.sends).toHaveLength(1);
  await h.emit('turn.start', { agentId: 'sub', turnId: 'again', text: 'More' }); await h.step({ input_tokens: 2, output_tokens: 807, cache_read_input_tokens: 0, cache_creation_input_tokens: 49745, model: 'claude-haiku-5-5' }, 'sub', 'again');
  await h.emit('turn.complete', { agentId: 'sub', turnId: 'again', reason: 'answer', durationMs: 100, answer: 'WAITING' }); await h.advance(240000);
  expect(h.sends).toHaveLength(2); expect(h.sends[1]!.text.startsWith('Keep-warm poke 1/1:')).toBe(true);
});
test('a sub-agent poke may call tools: the wait continues and the poke is charged once', async () => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait(); await h.advance(240000);
  await h.emit('turn.start', { agentId: 'sub', turnId: 'warm-sub', text: h.sends[0]!.text });
  await h.emit('tool.call', { agentId: 'sub', tool: 'Read', file_path: 'x' }, { result: 'x' }); await h.warmReply();
  expect(h.pending).toHaveLength(1); expect(h.rows().filter((r: any) => r.kind === 'subagent' && r.event === 'warm')).toHaveLength(1);
});
test.each(['idle', 'completed', 'failed', 'killed', 'running'])('sub-agent %s is checked immediately before send', async status => {
  const h = new Harness(sub); await h.start(); await h.agentWait(); expect(h.pending).toHaveLength(1);
  h.agents.find(a => a.id === 'sub')!.status = status; await h.advance(240000); expect(h.sends).toHaveLength(0); expect(h.pending).toHaveLength(0);
});
test.each(['unowned', 'option', 'environment', 'off', 'foreign', 'compact', 'end'])('sub-agent cancellation %s never warms', async kind => {
  const h = new Harness(kind === 'option' ? { ...sub, keepwarmSubagents: false } : sub, kind === 'environment' ? { CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENTS: '0' } : {});
  await h.start(); await h.agentWait('sub', kind !== 'unowned');
  if (kind === 'off') await h.command('off'); if (kind === 'foreign') await h.emit('turn.start', { agentId: 'sub', turnId: 'foreign', text: 'New work' });
  if (kind === 'compact') await h.emit('session.compact'); if (kind === 'end') await h.emit('session.end', { reason: 'exit' });
  await h.advance(300000); expect(h.sends).toHaveLength(0); expect(h.pending).toHaveLength(0);
});
test('sub-agent forecast uses the previous poke\'s actual spend and stops before a losing next poke', async () => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait(); await h.advance(240000); expect(h.sends).toHaveLength(1);
  await h.warmReply(10000); expect(h.pending).toHaveLength(0); expect(h.rows().some((r: any) => r.kind === 'subagent' && r.reason === 'budget')).toBe(true);
});
test('sub-agent admission counts the parent wake: a large parent stops a poke the sub-agent alone would afford', async () => {
  for (const [parent, sends] of [[null, 2], [200000, 1]] as const) {
    const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start();
    if (parent) await h.step({ input_tokens: 2, output_tokens: 10, cache_read_input_tokens: parent, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' });
    await h.agentWait(); for (let i = 0; i < 3; i++) { await h.advance(240000); if (h.sends.length > i) await h.warmReply(); }
    expect(h.sends).toHaveLength(sends); expect(h.rows().some((r: any) => r.kind === 'subagent' && r.reason === 'budget')).toBe(true);
  }
});
test('concurrent agents own distinct timers and foreign turns cannot revive an old warm', async () => {
  const h = new Harness(sub); await h.start(); await h.agentWait('one'); await h.agentWait('two'); expect(h.pending).toHaveLength(2);
  await h.advance(240000); expect(h.sends.map(s => s.to.agentId).sort()).toEqual(['one', 'two']);
  await h.emit('turn.start', { agentId: 'one', turnId: 'foreign', text: 'Changed' }); await h.warmReply(3, 'one'); expect(h.pending).toHaveLength(0);
});
test('late admitted warm after off accounts once without reviving a grant', async () => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait(); await h.advance(240000);
  const text = h.sends[0]!.text; await h.emit('turn.start', { agentId: 'sub', turnId: 'warm-sub', text }); await h.command('off');
  await h.warmReply(); expect(h.rows().filter((r: any) => r.kind === 'subagent' && r.event === 'warm')).toHaveLength(1);
  expect((await h.command('status')).text).toContain('session 1 warms'); expect(h.pending).toHaveLength(0);
  await h.emit('turn.complete', { agentId: 'sub', turnId: 'warm-sub', reason: 'answer', usage: h.pokeUsage });
  expect((await h.command('status')).text).toContain('session 1 warms');
});
test('foreign turn without a new cached request cannot re-use the previous request grant', async () => {
  const h = new Harness(sub); await h.start(); await h.agentWait(); await h.emit('turn.start', { agentId: 'sub', turnId: 'new', text: 'Changed' });
  await h.emit('turn.complete', { agentId: 'sub', turnId: 'new', reason: 'answer' }); expect(h.pending).toHaveLength(0);
});
test.each(['slow', 'list-error', 'send-refused', 'send-error', 'task-ended', 'idle-child'])('sub-agent boundary %s fails closed', async kind => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait();
  if (kind === 'slow') h.engine.agent.list = async () => { h.now += 60000; return h.agents as any; };
  if (kind === 'list-error') h.engine.agent.list = async () => { throw new Error('roster unavailable'); };
  if (kind === 'send-refused') h.sendImpl = async () => ({ isDelivered: false, reason: 'gone' });
  if (kind === 'send-error') h.sendImpl = async () => { throw new Error('send unavailable'); };
  if (kind === 'idle-child') { h.agents.push({ id: 'child', status: 'idle', parentId: 'sub', description: 'Child work' } as any); await h.emit('classic.SubagentStop', { agent_id: 'sub', background_tasks: [] }); }
  if (kind === 'task-ended') await h.emit('classic.SubagentStop', { agent_id: 'sub', background_tasks: [{ id: 'work-sub', type: 'shell', status: 'completed', description: 'Work' }] });
  await h.advance(240000); expect(h.sends).toHaveLength(kind.startsWith('send') ? 1 : 0); expect(h.pending).toHaveLength(0);
});
test('a departed sub-agent warm never writes usage or anchors into the cleared session', async () => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait(); await h.advance(240000);
  const text = h.sends[0]!.text; await h.emit('turn.start', { agentId: 'sub', turnId: 'warm-sub', text });
  h.id = 'new-session'; await h.emit('session.end', { reason: 'clear' }, { sessionId: h.id });
  await h.warmReply(); expect((await h.command('status')).text).toContain('session 0 warms');
  expect(h.writes.filter(text => JSON.parse(text).session === 'new-session').join('')).not.toContain('\"kind\":\"subagent\"');
  expect(h.writes.some(text => text.includes('"event":"warm"'))).toBe(true); expect(h.pending).toHaveLength(0);
});
test('native self-send may skip start and step but complete accounts and re-anchors using the receipt', async () => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait(); await h.advance(240000);
  h.messages = [{ role: 'user', text: `The coordinator sent a message while you were working:\n${h.sends[0]!.text}\n\nAddress this before completing your current task.`, toolUses: [] }, { role: 'assistant', text: 'waiting', toolUses: [] }];
  const usage = { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 50000, cache_creation_input_tokens: 126, model: 'claude-haiku-5-5' };
  await h.emit('turn.complete', { agentId: 'sub', turnId: 'native-warm', reason: 'answer', answer: 'waiting', usage });
  expect(h.rows().some((r: any) => r.kind === 'subagent' && r.event === 'warm' && r.spent === 5271)).toBe(true); expect(h.pending[0]?.at).toBe(h.now + 240000);
});
test.each(['waiting', 'Done'])('native hand-back %s remains an ordinary delivery; no unproven report suppression', async result => {
  const h = new Harness(sub); await h.arm(); await h.agentWait(); await h.advance(240000);
  h.messages = [{ role: 'user', text: h.sends[0]!.text, toolUses: [] }, { role: 'assistant', text: 'waiting', toolUses: [] }];
  const input = { origin: { kind: 'task-notification' }, text: `<task-notification><task-id>sub</task-id><tool-use-id>toolu_plugin_abc</tool-use-id><result>${result}</result></task-notification>` };
  expect((await h.emit('session.receive', input, { text: input.text })).result).toEqual({ text: input.text });
});
test.each(['list-error', 'send-refused', 'send-error'])('late %s stop log cannot cancel a newer request grant', async kind => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait();
  let release!: () => void, reached!: () => void; const blocked = new Promise<void>(r => { reached = r; }), wait = new Promise<void>(r => { release = r; });
  const list = h.engine.agent.list;
  if (kind === 'list-error') h.engine.agent.list = async () => { throw new Error('roster unavailable'); };
  if (kind === 'send-refused') h.sendImpl = async () => ({ isDelivered: false, reason: 'gone' });
  if (kind === 'send-error') h.sendImpl = async () => { throw new Error('send unavailable'); };
  h.writeImpl = async () => { if (h.writes.at(-1)?.includes('"event":"stop"')) return; reached(); await wait; };
  await h.advance(240000); await blocked; h.engine.agent.list = list;
  await h.emit('turn.start', { agentId: 'sub', turnId: 'new', text: 'Changed' });
  const step = h.step(undefined, 'sub', 'new'); await h.settle(); release(); await step;
  await h.emit('turn.complete', { agentId: 'sub', turnId: 'new', reason: 'answer' });
  expect(h.pending).toHaveLength(1);
});
test('late unknown-usage completion log cannot cancel a newer grant', async () => {
  const h = new Harness(sub, { PLUGIN_LOG_DIR: 'logs' }); await h.start(); await h.agentWait(); await h.advance(240000);
  await h.emit('turn.start', { agentId: 'sub', turnId: 'warm-sub', text: h.sends[0]!.text });
  let release!: () => void, reached!: () => void; const blocked = new Promise<void>(r => { reached = r; }), wait = new Promise<void>(r => { release = r; });
  h.writeImpl = async () => { reached(); await wait; };
  const complete = h.emit('turn.complete', { agentId: 'sub', turnId: 'warm-sub', reason: 'answer' }); await blocked;
  await h.emit('turn.start', { agentId: 'sub', turnId: 'new', text: 'Changed' });
  const step = h.step(undefined, 'sub', 'new'); await h.settle(); release(); await step;
  await h.emit('turn.complete', { agentId: 'sub', turnId: 'new', reason: 'answer' }); await complete;
  expect(h.pending).toHaveLength(1);
});
