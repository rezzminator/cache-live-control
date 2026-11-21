import { expect, test } from 'vitest';
import { requests, usage, poke, message, mainLane, checkPair, pair, launchText } from './live-fixtures.ts';
/** The cap lane: two pokes, the plugin's poke-limit stop, then a wait running past when a third would have been due. */
function capLane() {
  const lane: any = mainLane(2, { max: 2, back: 900000, read: 20000 });
  lane.log.push({ event: 'decision', at: 1000000 + 486000, epoch: 2, reason: 'poke-limit', pokes: { count: 2, max: 2 } });
  lane.limitState = { state: 'stopped', reason: 'poke-limit', pokes: { count: 2, max: 2 } };
  return lane;
}
test.each([['good', 0, 'PASS cap: 2 pokes, then none'], ['third', 2, 'FAIL cap: pokes'], ['no-limit', 2, 'FAIL cap: no poke-limit decision'], ['short', 2, 'NOT RUN: the wait ended before a third poke was due'], ['no-limit-state', 2, 'FAIL poke limit session state absent'], ['launch-prompt', 0, 'PASS cap: 2 pokes, then none']] as const)('cap evidence %s is judged', (problem, status, text) => {
  let lane: any = capLane();
  if (problem === 'third') { const three: any = mainLane(3, { max: 2, back: 900000, read: 20000 }); lane = { ...three, log: [...three.log, lane.log.at(-1)], limitState: lane.limitState }; }
  if (problem === 'no-limit') lane.log = lane.log.filter((r: any) => r.reason !== 'poke-limit');
  if (problem === 'short') { const short: any = mainLane(2, { max: 2, back: 700000, read: 20000 }); lane = { ...short, log: [...short.log, lane.log.at(-1)], limitState: lane.limitState }; }
  if (problem === 'no-limit-state') delete lane.limitState;
  if (problem === 'launch-prompt') lane.transcript.unshift(message(launchText, 500, 'user'));
  const result = checkPair({ mode: 'cap', lanes: [lane] });
  expect(result.status, result.stdout).toBe(status); expect(result.stdout).toContain(text);
});
test.each(['good', 'cold-warm', 'tool', 'main-poke', 'no-admit', 'warm-control', 'no-usage', 'wrong-output', 'wrong-spend', 'wrong-ledger', 'wrong-id', 'missing-parent-return', 'no-parent-wake', 'launch-prompt'])('sub-agent evidence %s is independently judged', problem => {
  const sub = (text: string, at: number, read = 49000, type = 'assistant') => ({ type, at, ...(type === 'user' && text.includes('<task-notification>') ? { origin: { kind: 'task-notification' } } : {}), message: { id: String(at), model: 'claude-haiku-5-5', content: [{ type: 'text', text }], usage: { ...usage(read), cache_creation_input_tokens: 49000 - read } } });
  const pokes = { count: 1, max: 4 };
  const lane = (warm: boolean): any => ({ debug: '', effort: [], transcript: [...requests(), ...(warm ? [sub('<task-notification><task-id>a</task-id><result>waiting</result></task-notification>', 241050, 0, 'user'), sub('STILL_WAITING', 241100)] : []), sub('<task-notification><task-id>a</task-id><result>SUBAGENT_RETURNED</result></task-notification>', 542000, 0, 'user'), sub('RETURNED', 543000)], agentId: 'a', subagentPath: 'agent-a.jsonl', log: [{ event: 'LOADED' }, ...(warm ? [{ kind: 'subagent', agentId: 'a', event: 'admit', reason: 'eligible', at: 240000, pokes }, { kind: 'subagent', agentId: 'a', event: 'warm', at: 241000, pokes, usage: usage(49000), spent: 5915, warms: 1, ledger: { spent: 5915, warms: 1 } }] : [])], subagent: [
    { type: 'assistant', at: 0, message: { content: [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'sleep 540', run_in_background: true } }] } },
    { type: 'user', at: 0, toolUseResult: { backgroundTaskId: 'work' }, message: { content: [{ type: 'tool_result', tool_use_id: 'shell' }] } }, sub('SUBAGENT_WAITING', 1000),
    ...(warm ? [sub(poke(1, 4, 'work').replace('agent `work`', 'command `work`'), 240000, 49000, 'user'), sub('waiting', 241000)] : []),
    sub('<task-notification><task-id>work</task-id></task-notification>', 540000, 0, 'user'), sub('SUBAGENT_RETURNED', 541000, warm ? 49000 : 0)] });
  const input: any = { mode: 'subagent-wait', lanes: [lane(true), lane(false)] }, warm = input.lanes[0];
  if (problem === 'no-usage') delete warm.log[2].usage;
  if (problem === 'wrong-output') warm.log[2].usage.output_tokens = 0;
  if (problem === 'wrong-spend') warm.log[2].spent = 1;
  if (problem === 'wrong-ledger') warm.log[2].ledger.spent = 1;
  if (problem === 'cold-warm') warm.subagent[4].message.usage.cache_read_input_tokens = 0;
  if (problem === 'tool') warm.subagent[4].message.content.push({ type: 'tool_use', name: 'TaskOutput' });
  if (problem === 'main-poke') warm.transcript.push(message(poke(1), 240000, 'user'));
  if (problem === 'no-admit') warm.log = warm.log.filter((r: any) => r.event !== 'admit');
  if (problem === 'wrong-id') warm.subagent[3].message.content[0].text = warm.subagent[3].message.content[0].text.replace('`work`', '`other`');
  if (problem === 'missing-parent-return') warm.transcript.pop();
  if (problem === 'no-parent-wake') warm.transcript.splice(3, 2);
  if (problem === 'warm-control') input.lanes[1].subagent.at(-1).message.usage.cache_read_input_tokens = 49000;
  if (problem === 'launch-prompt') for (const l of input.lanes) { l.transcript.unshift(sub(launchText, 0, 0, 'user')); l.subagent.unshift(sub(launchText, 0, 0, 'user')); }
  const result = checkPair(input), accepted = ['good', 'tool', 'no-parent-wake', 'launch-prompt'].includes(problem);
  expect(result.status, result.stdout).toBe(accepted ? 0 : 2);
  // The parent wake is observed and recorded, never failed; the model may call a tool in its poke turn.
  if (problem === 'good') expect(JSON.parse(result.stdout).lanes[0]).toMatchObject({ pokes: 1, pokeTools: [], parentWakes: 1, parentWakeRequests: [1], parentReturnRequests: 1 });
  if (problem === 'tool') expect(JSON.parse(result.stdout).lanes[0].pokeTools).toEqual(['TaskOutput']);
  if (problem === 'no-parent-wake') expect(JSON.parse(result.stdout).lanes[0]).toMatchObject({ parentWakes: 0, parentWakeRequests: [] });
});
// The runner's launch prompt names the poke header; only a poke's own header line opens a poke turn (the live run of 2026-10-19 read the launch as poke 0).
test('a launch prompt that names the poke is the chat\'s own prompt, never a poke', () => {
  const input: any = pair();
  for (const lane of input.lanes) lane.transcript.unshift(message(launchText, 500, 'user'));
  const result = checkPair(input);
  expect(result.status, result.stdout).toBe(0);
});
