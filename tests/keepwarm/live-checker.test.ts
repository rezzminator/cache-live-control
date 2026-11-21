import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { script, requests, usage, message, poke, mainLane, pair, checkPair, python } from './live-fixtures.ts';
test.each([
  [{ lanes: [{ transcript: [{ message: { model: '<synthetic>' } }], trustBlocked: true }] }, 'VOID API/auth'],
  [{ lanes: [{ debug: '[ERROR] API authentication failed' }] }, 'VOID API/auth'],
  [{ lanes: [{ transcript: [{ isApiErrorMessage: true }] }] }, 'VOID API/auth'],
  [{ lanes: [{ trustBlocked: true }] }, 'BLOCKED folder trust'],
  [{ lanes: [{}] }, 'ERROR need plugin load marker'],
])('live validity is not cache absence %#', (input, text) => {
  const dir = mkdtempSync(join(tmpdir(), 'keepwarm-check-'));
  try {
    const path = join(dir, 'evidence.json'); writeFileSync(path, JSON.stringify(input));
    const result = spawnSync('python3', ['-I', script, path], { encoding: 'utf8' });
    expect(result.status).toBe(2); expect(result.stdout).toContain(text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('independent complete evidence is accepted', () => expect(checkPair(pair()).status).toBe(0));
test.each(['wrong-time', 'missing-poke', 'extra-turn', 'effort-step', 'missing-state', 'state-survived', 'missing-debug', 'poke-text', 'wrong-id', 'cold-poke', 'control-poke', 'lapse'])('mechanism evidence rejects %s', problem => {
  const input: any = pair(), warm = input.lanes[0];
  if (problem === 'wrong-time') warm.log.find((r: any) => r.event === 'admit').at += 10000;
  if (problem === 'missing-poke') warm.log = warm.log.filter((r: any) => !(r.event === 'poke' && r.pokes.count === 2));
  if (problem === 'poke-text') warm.transcript[1].message.content[0].text = warm.transcript[1].message.content[0].text.replace('stop it now', 'leave it');
  if (problem === 'wrong-id') warm.transcript[3].message.content[0].text = warm.transcript[3].message.content[0].text.replace('task1', 'other');
  if (problem === 'cold-poke') warm.log.find((r: any) => r.event === 'poke').usage = usage(0);
  if (problem === 'control-poke') input.lanes[1].transcript.splice(1, 0, warm.transcript[1], warm.transcript[2]);
  if (problem === 'lapse') input.lanes[0] = mainLane(1);
  if (problem === 'extra-turn') warm.transcript.splice(1, 0, { type: 'assistant', message: { content: [{ text: 'extra request' }] } });
  if (problem === 'effort-step') warm.effort = [{ event: 'turn', ts: 1001010, turnId: 'w' }, { event: 'step', ts: 1100000, turnId: 'x' }];
  if (problem === 'missing-state') delete warm.returnedState;
  if (problem === 'state-survived') warm.returnedState = warm.waitingState;
  if (problem === 'missing-debug') delete warm.debug;
  expect(checkPair(input).status).toBe(2);
});
test('auto-effort stepping inside a poke turn is the poke\'s own, not wait-time work', () => {
  const input: any = pair();
  input.lanes[0].effort = [{ event: 'turn', ts: 1001010, turnId: 'w' }, { event: 'step', ts: 1242000, turnId: 'p1' }];
  expect(checkPair(input).status, checkPair(input).stdout).toBe(0);
});
test('collision checker rejects a stale post-cancel admission', () => {
  const result = python(`before={'transcript':[{'type':'assistant','at':0,'message':{'content':'WAITING'}},{'type':'assistant','at':201000,'message':{'content':'PONG'}}], 'debug':'', 'log':[{'event':'LOADED'}, {'event':'cancel','at':200000,'epoch':2}, {'event':'admit','at':440000,'epoch':3}]}
during={'transcript':[], 'debug':'', 'log':[{'event':'LOADED'},{'event':'admit','at':239000,'epoch':3},{'event':'cancel','at':240000,'epoch':4},{'event':'admit','at':242000,'epoch':3},{'event':'poke','at':242500,'epoch':3}]}
try: m.special([before,during],'collision')
except (ValueError,RuntimeError): sys.exit(0)
sys.exit(1)`);
  expect(result.status, result.stderr).toBe(0);
});
test('special checker rejects native error-flagged replies before outcome checks', () => {
  const result = python(`item={'transcript':[{'isApiErrorMessage':True}], 'debug':'','log':[{'event':'LOADED'}]}
try: m.special([item,item],'stale')
except (ValueError,RuntimeError) as e:
 print(e);sys.exit(0 if 'VOID' in str(e) else 1)
sys.exit(1)`);
  expect(result.status, result.stderr).toBe(0);
});
test('cleanup attempts socket verification even if the server kill times out', () => {
  const result = python(`seen=[]
def run(args,**kwargs):
 seen.append(args)
 if 'kill-server' in args: raise subprocess.TimeoutExpired(args,30)
 return types.SimpleNamespace(returncode=1,stdout='',stderr='')
m.run=run;m.marked_pids=lambda marker: []
result=m.cleanup('owned','marker','owned-socket')
assert seen==[['tmux','-L','owned-socket','kill-server'],['tmux','-L','owned-socket','list-sessions']] and result['nativeSocketClosed'] and result['errors'],(seen,result)`);
  expect(result.status, result.stderr).toBe(0);
});
test.each(['fifo', 'symlink', 'oversized'])('evidence reader refuses %s without blocking', kind => {
  const result = python(`import os
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)/'input'
 if sys.argv[2]=='fifo': os.mkfifo(p)
 elif sys.argv[2]=='symlink':\n  target=pathlib.Path(d)/'target';target.write_text('{}\\n');p.symlink_to(target)
 else:
  with p.open('wb') as f: f.write(b' '*(70*1024*1024))
 try: m.rows(p)
 except (ValueError,OSError,RuntimeError): sys.exit(0)
 sys.exit(1)`.replaceAll('sys.argv[2]', JSON.stringify(kind)));
  expect(result.status, result.stderr).toBe(0);
});
test('all runs the four 5m sequences and leaves ttl-1h to its own lane', () => {
  const result = python(`with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);plugin=root/'plugin';(plugin/'.claude-plugin').mkdir(parents=True);(plugin/'.claude-plugin/plugin.json').write_text('{}')
 seen=[]
 m.run=lambda *a,**k: types.SimpleNamespace(returncode=0,stdout='2.1.316',stderr='')
 def lane(args,output,mode,**kwargs):
  output.mkdir(parents=True,exist_ok=True);seen.append(mode);return {}
 m.lane=lane;m.special=lambda *a: 'PASS mock safety';m.checker.check_cap=lambda lane: {'verdict':'PASS mock cap'};m.shutil.which=lambda tool: tool
 sys.argv=['runner','--all','--auto-effort-dir',str(plugin),'--output',str(root/'out')]
 result=m.main()
 assert seen==['warm','control','cap','input','delivery','killed'] and result==0,(seen,result)`);
  expect(result.status, result.stderr).toBe(0);
});
test('late API failure becomes VOID during polling rather than a return timeout', () => {
  const result = python(`with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);cwd=root/'work';project=root/'.claude/projects'/m.re.sub(r'[^a-zA-Z0-9]','-',str(cwd));project.mkdir(parents=True)
 debug=root/'.claude/debug';debug.mkdir();(debug/'thread.txt').write_text('')
 m.os.environ={};m.Path.home=classmethod(lambda cls: root);m.marked_pids=lambda marker: []\n clock=[0]\n def now(): clock[0]+=100;return clock[0]\n m.time.monotonic=now;m.time.sleep=lambda seconds: None
 def run(args,**kwargs):
  if 'new-session' in args:
   (project/'thread.jsonl').write_text('{}\\n');return types.SimpleNamespace(returncode=0,stdout='',stderr='')
  return types.SimpleNamespace(returncode=0 if 'capture-pane' in args else 1 if args[0]=='tmux' else 0,stdout='',stderr='')
 m.run=run
 class Journal:
  def __init__(self,path): self.n=0
  def poll(self):
   self.n+=1;return [{'type':'assistant','message':{'content':'WAITING'}}]+([{'isApiErrorMessage':True}] if self.n>1 else [])
 m.checker.Journal=Journal
 try: m.lane(types.SimpleNamespace(cwd=cwd,auto_effort_dir=root/'plugin',claude='claude'),root/'out','warm')
 except (ValueError,RuntimeError) as e:
  print(e);sys.exit(0 if 'VOID API/auth' in str(e) else 1)
 sys.exit(1)`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
function oneHour(warm: boolean) {
  const at = 1000000, gap = warm ? 4001000 : 421000;
  return { transcriptPath: 'transcript.jsonl', debug: '', effort: [],
    transcript: [message('WAITING', 0), ...(warm ? [message(poke(1), 2880100, 'user'), message('waiting', 2882000)] : []), message('<task-notification>LONG_PROBE_DONE</task-notification>', gap - 1000, 'user'), message('RETURNED', gap), ...requests()],
    log: [{ event: 'LOADED', at, epoch: 0, ttl: '5m', ttlSource: 'assumed' }, { event: 'step', at: at - 500, anchorAt: at - 500, epoch: 1, ttl: '5m', ttlSource: 'assumed' },
      { event: 'step', at, anchorAt: at, epoch: 1, ttl: '1h', ttlSource: 'env' }, { event: 'decision', at, epoch: 1, ttl: '1h', ttlSource: 'env', reason: warm ? 'eligible' : '1h-unproven' },
      ...(warm ? [{ event: 'admit', at: at + 2880000, epoch: 1, ttl: '1h', ttlSource: 'env' }, { event: 'poke', at: at + 2885000, epoch: 1, ttl: '1h', ttlSource: 'env', context: 50000, usage: usage(49000) }] : [])] };
}
function check1h(lane: unknown, warm: boolean) {
  return python(`lane=json.loads(sys.argv[2])
try: print(json.dumps(m.checker.check_1h(lane, ${warm ? 'True' : 'False'})))
except ValueError as e: print(e);sys.exit(2)`.replace('sys.argv[2]', JSON.stringify(JSON.stringify(lane))));
}
test.each([true, false])('1h evidence is accepted (warm1h %s)', warm => {
  const result = check1h(oneHour(warm), warm);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain(warm ? 'PASS ttl-1h refresh' : 'PASS ttl-1h refusal');
});
test.each([
  ['5m-ttl', true, 'ERROR need 1h rows'], ['assumed-source', true, 'ERROR need 1h rows'], ['short-gap', true, 'NOT RUN: main gap'],
  ['two-pokes', true, 'FAIL prescribed 1h poke'], ['late-admit', true, 'FAIL 1h admission timing'], ['cold-return', true, 'FAIL 1h refresh did not hold'],
  ['refusal-poke', false, 'FAIL 1h refusal admitted'], ['refusal-reason', false, 'FAIL 1h refusal reason'], ['refusal-cold', false, 'FAIL 1h TTL not in effect'],
] as const)('1h evidence rejects %s', (problem, warm, text) => {
  const lane: any = oneHour(warm), step = lane.log[3], reply = lane.transcript.find((r: any) => r.message.content[0]?.text === 'RETURNED');
  if (problem === '5m-ttl') step.ttl = '5m';
  if (problem === 'assumed-source') step.ttlSource = 'assumed';
  if (problem === 'short-gap') reply.timestamp = new Date(1000000 + 3500000).toISOString();
  if (problem === 'two-pokes') lane.log.push({ ...lane.log[5], at: 1000000 + 3000000 });
  if (problem === 'late-admit') lane.log[4].at += 10000;
  if (problem === 'cold-return' || problem === 'refusal-cold') reply.message.usage = { input_tokens: 1000, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 49000 };
  if (problem === 'refusal-poke') lane.log.push({ event: 'poke', at: 1200000, epoch: 1, ttl: '1h', ttlSource: 'env' });
  if (problem === 'refusal-reason') step.reason = 'eligible';
  const result = check1h(lane, warm);
  expect(result.status, result.stdout + result.stderr).toBe(2);
  expect(result.stdout).toContain(text);
});
test.each(['pair', '1h'])('a request keeping fewer messages than its base sent voids the lane before any cache verdict (%s)', kind => {
  const rewrite = (lane: any) => { lane.transcript.find((r: any) => r.id === 'r3').keep = 1; lane.log.find((r: any) => r.event === 'poke').usage.cache_read_input_tokens = 34000; };
  const input: any = kind === 'pair' ? pair() : oneHour(true);
  rewrite(kind === 'pair' ? input.lanes[0] : input);
  const result = kind === 'pair' ? checkPair(input) : check1h(input, true);
  expect(result.status, result.stdout + result.stderr).toBe(2);
  expect(result.stdout).toContain('VOID prefix rewritten mid-lane: request r3 kept 1 of 4 messages');
});
test('a lane without main-thread request records is not run, never clean', () => {
  const input: any = pair();
  input.lanes[1].transcript = input.lanes[1].transcript.filter((r: any) => r.type !== 'api-request');
  expect(checkPair(input).stdout).toContain('NOT RUN: main-thread request records missing');
});
test('cleanup treats a never-launched chat as gone once processes and socket are verified', () => {
  const result = python(`def run(args,**kwargs):
 if 'kill-server' in args: return types.SimpleNamespace(returncode=1,stdout='',stderr='no server running on /tmp/tmux-1000/owned\\n')
 return types.SimpleNamespace(returncode=1,stdout='',stderr='error connecting to /tmp/tmux-1000/owned (No such file or directory)\\n')
m.run=run;m.marked_pids=lambda marker: []
result=m.cleanup('owned','marker','owned')
assert result['nativeSocketClosed'] and result['errors']==[] and result['ownedProcessesRemaining']==[],result`);
  expect(result.status, result.stderr).toBe(0);
});
test('launch prompt stays under the single-argument limit', () => {
  const result = python(`text=m.launch_text(4000)
assert len(text.encode()) < m.ARG_LIMIT < 131072, len(text.encode())
assert 'STEPS' not in text and 'run_in_background true' not in text, text[:600]`);
  expect(result.status, result.stderr).toBe(0);
});
test('a seat-wide PLUGIN_LOG_DIR is where the lane reads, keeping only its own session', () => {
  const result = python(`with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d); seat=root/'seat'; lane=root/'lane'; config=root/'config'; config.mkdir(); lane.mkdir()
 store=root/'store.json'; store.write_text(json.dumps({'env':{'PLUGIN_LOG_DIR':str(seat)}})); (config/'settings.json').symlink_to(store); assert m.log_root(lane,config)==seat
 (config/'settings.json').unlink()
 (config/'settings.json').write_text('{}'); assert m.log_root(lane,config)==lane; assert m.log_root(lane,root/'absent')==lane
 log='"where":"hooks/keepwarm.ts#log"'; (seat/'cache-live-control').mkdir(parents=True); (seat/'auto-effort').mkdir()
 (seat/'cache-live-control'/'info.jsonl').write_text('{'+log+',"session":"s1","detail":{"event":"LOADED","at":1}}\\n{'+log+',"session":"s2","detail":{"event":"other","at":0}}\\n')
 (seat/'auto-effort'/'decisions.s1.jsonl').write_text('{"event":"mine"}\\n');(seat/'auto-effort'/'decisions.s10.jsonl').write_text('{"event":"theirs"}\\n')
 assert m.decision_rows(m.plugin_logs(seat),'s1')==[{'event':'LOADED','at':1}],m.decision_rows(m.plugin_logs(seat),'s1')
 assert m.effort_rows(seat,session='s1')==[{'event':'mine'}],m.effort_rows(seat,session='s1')`);
  expect(result.status, result.stderr).toBe(0);
});
test('lane log routing reads only decision rows and auto-effort decision files, and passes its env', () => {
  const result = python(`with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d); log='"where":"hooks/keepwarm.ts#log"'; effort=root/'auto-effort'
 (root/'cache-live-control').mkdir();effort.mkdir();(root/'cache-live-control'/'info.jsonl').write_text('{'+log+',"detail":{"event":"LOADED","at":1}}\\n');(root/'cache-live-control'/'errors.jsonl').write_text('{'+log+',"detail":{"event":"stop","at":0}}\\n{"where":"hooks/keepwarm.ts#persist","detail":{}}\\n');(effort/'decisions.s1.jsonl').write_text('{"event":"step"}\\n');(effort/'decisions.s1.2.jsonl').write_text('{"event":"step","n":2}\\n');(effort/'decisions.s1.subagent.jsonl').write_text('{"event":"step","agent":"a"}\\n');(effort/'errors.jsonl').write_text('{"event":"not-a-decision"}\\n')
 assert sorted(p.name for p in m.plugin_logs(root))==['errors.jsonl','info.jsonl'],m.plugin_logs(root); assert m.decision_rows(m.plugin_logs(root))==[{'event':'stop','at':0},{'event':'LOADED','at':1}],m.decision_rows(m.plugin_logs(root))
 assert m.effort_rows(root)==[{'event':'step'},{'event':'step','n':2}],m.effort_rows(root); assert m.effort_rows(root,subagent=True)==[{'event':'step','agent':'a'}]
 assert m.debug_text(root)==('',False)
 seen={};m.cleanup=lambda *a:{'nativeSocketClosed':True,'ownedProcessesRemaining':[],'errors':[]}
 def launch(argv,**kw): seen.update(kw['env']);return types.SimpleNamespace(stdout='',stderr='stopped fixture',returncode=1)
 m.run=launch
 try: m.lane(types.SimpleNamespace(cwd=root,auto_effort_dir=root,claude='claude'),root/'out','warm')
 except RuntimeError as e: assert 'stopped fixture' in str(e)
 assert seen.get('PLUGIN_LOG_DIR')==str(root/'out/warm'),seen.get('PLUGIN_LOG_DIR'); assert 'AUTO_EFFORT_LOG_FILE' not in seen,seen
 assert seen.get('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION')=='false',seen.get('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION')
 for p in effort.glob('decisions.*.jsonl'): p.unlink()
 try: m.effort_rows(root)
 except RuntimeError as e: assert 'need auto-effort log' in str(e);sys.exit(0)
 sys.exit(1)`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
test('a lane held at the folder-trust dialog is BLOCKED, nothing typed', () => {
  const result = python(`with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);seen=[]
 m.os.environ={};m.Path.home=classmethod(lambda cls: root);m.time.sleep=lambda seconds: None
 m.cleanup=lambda *a:{'nativeSocketClosed':True,'ownedProcessesRemaining':[],'errors':[]}
 trust=' Quick safety check: Is this a project you created or one you trust?\\n ❯ 1. Yes, I trust this folder\\n   2. No, exit\\n'
 def run(argv,**kw): seen.append(argv[3] if argv[1]=='-L' else 'new-session');return types.SimpleNamespace(stdout=trust if 'capture-pane' in argv else '',stderr='',returncode=0)
 m.run=run
 try: m.lane(types.SimpleNamespace(cwd=root,auto_effort_dir=root,claude='claude'),root/'out','warm')
 except RuntimeError as e: print(e)
 evidence=json.loads((root/'out/warm/evidence.json').read_text())
 assert evidence.get('trustBlocked') is True and 'send-keys' not in seen,(evidence,seen)`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('BLOCKED folder trust');
});
test.each([[{ at: 5 }, 5], [{ ts: 7 }, 7], [{ timestamp: '1970-01-01T00:00:01Z' }, 1000], [{ ts: '1970-01-01T00:00:02Z' }, 2000]])('timestamp reads every evidence stamp %#', (record, expected) => {
  const result = python(`print(m.checker.timestamp(json.loads(sys.argv[2])))`.replace('sys.argv[2]', JSON.stringify(JSON.stringify(record))));
  expect(result.status, result.stderr).toBe(0); expect(Number(result.stdout.trim())).toBe(expected);
});
test('the WAITING turn\'s own late step row is not wait-time effort work', () => {
  const input: any = pair();
  input.lanes[0].effort = [{ event: 'step', ts: 1001005, turnId: 'w' }, { event: 'turn', ts: 1001010, turnId: 'w' }];
  expect(checkPair(input).status).toBe(0);
});
test.each([[true, 0], [false, 2]])('a reply split into thinking and text records is one response (same id %s)', (same, status) => {
  const input: any = pair(), control = input.lanes[1], reply = control.transcript[2];
  reply.message.id = 'msg_a';
  control.transcript.splice(2, 0, { ...reply, message: { ...reply.message, id: same ? 'msg_a' : 'msg_b', content: [{ type: 'thinking', thinking: '' }] } });
  expect(checkPair(input).status).toBe(status);
});
test.each(['meta-reminder', 'handback'])('a 2.1.316 delivery is the quiet window\'s one record (%s)', shape => {
  const input: any = pair(), control = input.lanes[1], at = control.transcript.length - 5;
  const reminder = { type: 'user', isMeta: true, timestamp: control.transcript[at].timestamp, message: { content: '<system-reminder><tools-used-before-summary>Bash</tools-used-before-summary></system-reminder>' } };
  if (shape === 'meta-reminder') control.transcript.splice(at, 0, reminder);
  else control.transcript[at] = { ...reminder, origin: { kind: 'peer', from: 'task1', senderTaskId: 'task1', handback: true }, message: { content: 'Another Claude session sent a message: RETURNED' } };
  expect(checkPair(input).status).toBe(0);
});
test('a tool call quoting the reply words is not a reply', () => {
  const input: any = pair(), warm = input.lanes[0];
  warm.transcript.splice(0, 0, { type: 'assistant', timestamp: new Date(1000500).toISOString(), message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'reply WAITING, then RETURNED' } }] } });
  expect(checkPair(input).status, checkPair(input).stdout).toBe(0);
  const result = python(`r={'type':'assistant','message':{'content':[{'type':'tool_use','input':{'prompt':'reply RETURNED'}}]}}
assert 'RETURNED' not in m.content(r) and m.content({'message':{'content':'PONG'}})=='PONG'`);
  expect(result.status, result.stderr).toBe(0);
});
test('a stop signal mid-lane runs the lane cleanup and starts no later lane', () => {
  const result = python(`import os,signal,time
tmp=pathlib.Path(tempfile.mkdtemp()); (tmp/'ae/.claude-plugin').mkdir(parents=True); (tmp/'ae/.claude-plugin/plugin.json').write_text('{}')
m.shutil.which=lambda tool:'/bin/true'
m.run=lambda cmd,**k: subprocess.CompletedProcess(cmd,0,'2.1.316 (Claude Code)','')
calls=[]
def lane(args,directory,mode,**k):
 calls.append(mode)
 try:
  os.kill(os.getpid(),signal.SIGTERM); time.sleep(3)
 finally: print('CLEANED '+mode,flush=True)
 return {}
m.lane=lane
sys.argv=['live-proof','--all','--cwd',str(tmp),'--output',str(tmp/'out'),'--auto-effort-dir',str(tmp/'ae')]
print('RESULT',json.dumps({'calls':calls,'code':m.main()}))`);
  expect(result.stdout).toContain('CLEANED warm');
  expect(result.stdout).toContain('STOPPED live: signal 15');
  expect(result.stdout).toContain('RESULT {"calls": ["warm"], "code": 143}');
});
test('a stop signal during a cleanup waits for the cleanup to finish', () => {
  const result = python(`import os,signal
m.stop_on_signals()
def run(cmd,**k):
 if 'kill-server' in cmd: os.kill(os.getpid(),signal.SIGTERM)
 return subprocess.CompletedProcess(cmd,0 if 'kill-server' in cmd else 1,'','')
m.run=run; m.marked_pids=lambda marker: []
r=m.cleanup('kw-x','marker','kw-x')
print(json.dumps({'signal':m.STOP['signal'],'closed':r['nativeSocketClosed'],'errors':r['errors']}))`);
  expect(result.stdout.trim(), result.stderr).toBe('{"signal": 15, "closed": true, "errors": []}');
});
