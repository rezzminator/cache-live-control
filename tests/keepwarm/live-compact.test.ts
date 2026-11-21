import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import './live-fixtures.ts';
const runner = fileURLToPath(new URL('../../scripts/keepwarm-live-proof.py', import.meta.url));
// One polled warm lane whose plugin log holds `compact`; a later API error ends the lane, so reaching it proves the compact row did not void.
function lane(compact: Record<string, unknown>, screen = '', admit = false) {
  return spawnSync('python3', ['-I', '-B', '-c', `import importlib.util,sys,json,tempfile,pathlib,types
spec=importlib.util.spec_from_file_location('runner',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);cwd=root/'work';project=root/'.claude/projects'/m.re.sub(r'[^a-zA-Z0-9]','-',str(cwd));project.mkdir(parents=True)
 log=root/'plugin.jsonl';log.write_text(json.dumps({'where':'hooks/keepwarm.ts#log','session':'thread','detail':{'event':'LOADED','at':1}})+'\\n'+json.dumps({'where':'hooks/keepwarm.ts#log','session':'thread','detail':dict({'event':'compact','at':2},**json.loads(sys.argv[2]))})+'\\n'+(json.dumps({'where':'hooks/keepwarm.ts#log','session':'thread','detail':{'event':'admit','at':3,'epoch':3}})+'\\n' if sys.argv[4]=='1' else ''))
 m.os.environ={};m.Path.home=classmethod(lambda cls: root);m.marked_pids=lambda marker: [];m.plugin_logs=lambda directory: [log]
 clock=[0]
 def now(): clock[0]+=100;return clock[0]
 m.time.monotonic=now;m.time.sleep=lambda seconds: None
 def run(args,**kwargs):
  if 'new-session' in args:
   (project/'thread.jsonl').write_text('{}\\n');return types.SimpleNamespace(returncode=0,stdout='',stderr='')
  if 'capture-pane' in args: return types.SimpleNamespace(returncode=0,stdout=sys.argv[3],stderr='')
  return types.SimpleNamespace(returncode=0 if args[-1]=='Escape' else 1 if args[0]=='tmux' else 0,stdout='',stderr='')
 m.run=run
 class Journal:
  def __init__(self,path): self.n=0
  def poll(self):
   self.n+=1;return [{'type':'assistant','message':{'content':'WAITING'}}]+([{'isApiErrorMessage':True}] if self.n>2 else [])
 m.checker.Journal=Journal
 try: m.lane(types.SimpleNamespace(cwd=cwd,auto_effort_dir=root/'plugin',claude='claude'),root/'out','warm',release=True)
 except (ValueError,RuntimeError) as e: print(e)
 e=json.loads((root/'out/warm/evidence.json').read_text());print(json.dumps(e.get('compactEvents')));print(e.get('offersDismissed', 0));print((root/'out/warm/release').exists(), 'releasedAt' in e)`, runner, JSON.stringify(compact), screen, admit ? '1' : '0'], { encoding: 'utf8', timeout: 5000 });
}
test.each([[{ trigger: 'precompute' }], [{ trigger: 'auto', agentId: 'child' }], [{ trigger: 'precompute', agentId: 'child' }], [{ trigger: 'auto', outcome: 'skipped' }], [{ trigger: 'manual', outcome: 'failed' }]])('a %j compaction is recorded and never voids the lane', compact => {
  const result = lane(compact), [verdict, events] = result.stdout.trim().split('\n');
  expect(verdict, result.stderr).toContain('VOID API/auth'); expect(JSON.parse(events!)).toEqual([{ at: 2, ...compact }]);
});
test.each([[{ trigger: 'auto' }, 'auto'], [{ trigger: 'auto', outcome: 'installed' }, 'auto'], [{ trigger: 'manual', outcome: 'later' }, 'manual'], [{ trigger: 'manual' }, 'manual'], [{ trigger: 'plugin', agentId: '' }, 'plugin'], [{ trigger: 'unknown' }, 'unknown'], [{}, 'unrecorded'], [{ agentId: 'child' }, 'unrecorded']])('a main or unrecorded compaction %j voids the lane', (compact, trigger) => {
  const result = lane(compact);
  expect(result.stdout, result.stderr).toContain(`VOID compaction during the lane: ${trigger} compaction of the main session`);
});
test.each([['  Teach auto mode about your environment?\n  3. Don\'t show again', 2], ['  Fixture 1: Teach auto mode about your environment?', 0]])('the auto-mode setup offer on screen %j is closed with Escape %i times', (screen, count) => {
  const result = lane({ trigger: 'precompute' }, screen), lines = result.stdout.trim().split('\n');
  expect(lines[0], result.stderr).toContain('VOID API/auth'); expect(lines[2]).toBe(String(count));
});
test.each([[true, 'True True'], [false, 'False False']])('a delivery lane whose plugin log admits a poke (%s) writes its release file: %s', (admit, released) => {
  const result = lane({ trigger: 'precompute' }, '', admit), lines = result.stdout.trim().split('\n');
  expect(lines[0], result.stderr).toContain('VOID API/auth'); expect(lines[3]).toBe(released);
});
