import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { python, runner } from './live-fixtures.ts';
const tmux = spawnSync('tmux', ['-V']).status === 0;
// Real tmux, a stand-in claude: the lane's own server hands claude the lane env and the prompt as one argument, and
// cleanup leaves no marked process and no server behind.
test.skipIf(!tmux)('a lane chat launched through real tmux gets its env and prompt, and cleanup ends it', () => {
  const result = spawnSync('python3', ['-I', '-B', '-c', `import importlib.util,sys,os,json,pathlib,secrets,subprocess,tempfile,time
spec=importlib.util.spec_from_file_location('runner',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
marker=secrets.token_hex(10);socket='kw-test-'+marker[:8]
try:
 with tempfile.TemporaryDirectory() as d:
  root=pathlib.Path(d);bin=root/'bin';bin.mkdir();out=root/'argv.json';prompt=root/'prompt.txt'
  (bin/'claude').write_text('#!/usr/bin/env python3\\nimport json,os,sys,time\\nopen(os.environ["KW_TEST_OUT"],"w").write(json.dumps(sys.argv[1:]))\\ntime.sleep(600)\\n');(bin/'claude').chmod(0o755)
  text='line one "quoted" $HOME \\'single\\'\\nline two';prompt.write_text(text)
  env=dict(os.environ,PATH=str(bin)+os.pathsep+os.environ['PATH'],KW_TEST_OUT=str(out),KEEPWARM_LIVE_RUN=marker)
  launched=m.start_chat(socket,root,prompt,env,str(bin/'claude'))
  assert launched.returncode==0,launched.stderr
  deadline=time.monotonic()+15
  while not out.exists() and time.monotonic()<deadline: time.sleep(.1)
  time.sleep(.2)
  assert json.loads(out.read_text())==['--model','claude-haiku-5-5','--effort','low',text],out.read_text()
  assert m.marked_pids(marker),'no marked process'
  result=m.cleanup(socket,marker,socket)
  assert result['nativeSocketClosed'] and result['ownedProcessesRemaining']==[] and result['errors']==[],result
  print('LAUNCHED AND CLEANED')
finally: subprocess.run(['tmux','-L',socket,'kill-server'],capture_output=True)`, runner], { encoding: 'utf8', timeout: 30000 });
  expect(result.stdout, result.stderr).toContain('LAUNCHED AND CLEANED');
});
test.each([[755, [590, 165]], [4000, [590, 590, 590, 590, 590, 590, 460]], [420, [420]], [1180, [590, 590]]])('probe for %ss sleeps in foreground chunks under the Bash ceiling, each chunk naming the next', (seconds, chunks) => {
  const result = python(`steps=m.probe_steps(${seconds})
found=[int(n) for n in m.re.findall(r'time.sleep\\((\\d+)\\)', steps)]
assert found==${JSON.stringify(chunks)} and steps.count('LONG_PROBE_DONE')==1 and steps.count('DONE: run the next command now')==len(found)-1 and steps.endswith('LONG_PROBE_DONE")'+chr(39)+chr(96)) and steps.count(chr(96)+'sleep 1 && python3 -c')==len(found),(found,steps)`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
test.each([[true, 'LONG_PROBE_DONE', 0, 1], [false, 'LONG_PROBE_DONE', 2, 6]])('a released delivery probe (release written: %s) prints %s once its file appears or its cap passes', (written, done, low, high) => {
  const result = python(`with tempfile.TemporaryDirectory() as d:
 release=pathlib.Path(d)/'release'
 steps=m.probe_steps(2, release)
 command=m.re.findall(r'sleep 1 && (python3 -c .*)'+chr(96), steps)[-1]
 if ${written ? 'True' : 'False'}: release.touch()
 start=m.time.monotonic();out=subprocess.run(["sh","-c",command],capture_output=True,text=True,timeout=10).stdout.strip();took=m.time.monotonic()-start
 assert out=='${done}' and ${low}<=took<${high},(out,took,command)`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
test('a lane starts claude in its own tmux server with the prompt file as one argument and fresh launch state', () => {
  const result = python(`with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);seen=[]
 m.os.environ={'CLAUDECODE':'1','CLAUDE_CODE_SESSION_ID':'parent','ENABLE_PROMPT_CACHING_1H':'1','CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL':'1h','CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES':'9','CACHE_LIVE_CONTROL_RAISE_AFTER_EXPIRIES':'1','KEEP':'yes'};m.Path.home=classmethod(lambda cls: root)
 m.cleanup=lambda *a:{'nativeSocketClosed':True,'ownedProcessesRemaining':[],'errors':[]}
 def run(argv,**kw): seen.append((argv,kw.get('env')));return types.SimpleNamespace(stdout='',stderr='stopped fixture',returncode=1)
 m.run=run
 try: m.lane(types.SimpleNamespace(cwd=root,auto_effort_dir=root,claude='/opt/claude-code/claude'),root/'out','ttl-1h',cache='1h')
 except RuntimeError as e: assert 'ERROR launch' in str(e) and 'stopped fixture' in str(e),e
 argv,env=seen[0]
 assert argv[:2]==['tmux','-f'] and argv[argv.index('-L')+1].startswith('kw-ttl-1h-') and argv[argv.index('-c')+1]==str(root),argv
 assert argv[-5:]==['-c','exec "$2" --model claude-haiku-5-5 --effort low "$(cat "$1")"','sh',str(root/'out/ttl-1h/prompt.txt'),'/opt/claude-code/claude'],argv
 assert env['CLAUDE_CODE_PROMPT_CACHE_TTL']=='1h' and env['KEEP']=='yes' and not {'CLAUDECODE','CLAUDE_CODE_SESSION_ID','ENABLE_PROMPT_CACHING_1H','CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL','CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES','CACHE_LIVE_CONTROL_RAISE_AFTER_EXPIRIES'} & set(env),env`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
