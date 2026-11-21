import { expect, test } from 'vitest';
import { checkPair, python } from './live-fixtures.ts';
const initial = { v: 1, sessionId: 'main-state', pid: 1234, updatedAt: 1792247410124, enabled: true, source: 'launch', state: 'on', reason: 'idle', pokes: { count: 0, max: 4 }, nextAt: null, protectingTokensEq: null };
const off = { ...initial, updatedAt: initial.updatedAt + 1000, enabled: false, source: 'session', state: 'off', reason: 'off' };
const evidence = () => ({ mode: 'state', sessionId: initial.sessionId, pidAlive: true, initialState: { ...initial }, offState: { ...off } });
test('live state evidence proves the v1 write and immediate off replacement', () => {
  const result = checkPair(evidence());
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('PASS v1 state write then /keepwarm off');
});
test.each(['identity', 'version', 'off', 'pid', 'time', 'counter', 'private-field', 'api-error'])('live state checker rejects %s', problem => {
  const input: any = evidence();
  if (problem === 'identity') input.offState.sessionId = 'another-session';
  if (problem === 'version') input.initialState.v = 2;
  if (problem === 'off') input.offState.enabled = true;
  if (problem === 'pid') input.offState.pid = 4321;
  if (problem === 'time') input.offState.updatedAt = initial.updatedAt - 1;
  if (problem === 'counter') input.initialState.pokes = { count: -1, max: 4 };
  if (problem === 'private-field') input.initialState.label = 'private task';
  if (problem === 'api-error') input.transcript = [{ isApiErrorMessage: true }];
  const result = checkPair(input);
  expect(result.status).toBe(2);
  expect(result.stdout).toMatch(/FAIL|VOID API/);
});
test('state-only live invocation needs no comparison plugin and launches one lane', () => {
  const result = python(`seen=[]
m.stop_on_signals=lambda:None
m.shutil.which=lambda _: '/tools/available'
def run(args,**kwargs):
 return types.SimpleNamespace(returncode=0,stdout='2.1.316',stderr='')
m.run=run
def lane(args,output,mode,**kwargs):
 seen.append(mode)
 return json.loads(${JSON.stringify(JSON.stringify(evidence()))})
m.lane=lane
with tempfile.TemporaryDirectory() as directory:
 sys.argv=['live-proof.py','--lane','state','--cwd',directory,'--output',directory+'/evidence']
 result=m.main()
 assert result == 0, result
 assert seen == ['state'], seen`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
