import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
/** Shared evidence fixtures for the live checker and runner tests. */
// macOS keeps tmpdir under the /var -> /private/var link, which the evidence reader refuses by design: tests and their python children get the canonical path.
process.env.TMPDIR = realpathSync(tmpdir());
export const script = fileURLToPath(new URL('../../scripts/keepwarm-live-check.py', import.meta.url));
export const runner = fileURLToPath(new URL('../../scripts/keepwarm-live-proof.py', import.meta.url));
export const at = 1000000;
export const requests = () => [{ type: 'api-request', querySource: 'repl_main_thread', id: 'r1', keep: 0, tail: ['a', 'b'] },
  { type: 'api-request', querySource: 'repl_main_thread', id: 'r2', base: 'r1', keep: 2, tail: ['c', 'd'] },
  { type: 'api-request', querySource: 'repl_main_thread', id: 'r3', base: 'r2', keep: 4, tail: ['e'] }];
export const usage = (read: number) => ({ input_tokens: 1000, output_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: 49000 - read });
/** The visible poke text, exactly as the plugin renders it for one pending agent. */
export const poke = (n: number, max = 4, id = 'task1') => [`Keep-warm poke ${n}/${max}: your prompt cache was about to expire, so this message keeps it warm while you wait on:`, `- agent \`${id}\`: probe, pending ${4 * n}m`, 'If any of these is stale or was started by accident, stop it now. Otherwise reply with the single word `waiting` and nothing else: this turn only keeps the cache warm, and the plugin reads nothing from your reply.'].join('\n');
/** A lane's launch prompt, as the runner words it: it names the poke header, yet it is the chat's own prompt, never a poke. */
export const launchText = 'Live cache experiment, no repository work. A message headed Keep-warm poke is part of this experiment: the agent it lists is intentional and not stale, so reply exactly waiting and end your turn, with no tool call.';
export const message = (text: string, offset: number, type = 'assistant', read = 49000) => ({ type, timestamp: new Date(at + offset).toISOString(), message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text }], usage: usage(read) } });
/** A main lane with `count` pokes, each admitted 4 minutes after the main request before it, then the agent's return. */
export function mainLane(count: number, { max = 4, back = 756000, read = 49000 } = {}) {
  const transcript: any[] = [message('WAITING', 1000)], log: any[] = [{ event: 'LOADED', at, epoch: 0 }, { event: 'step', at, anchorAt: at, epoch: 1 }];
  const items = [{ id: 'task1', kind: 'agent', label: 'probe' }];
  let anchor = at;
  for (let n = 1; n <= count; n++) {
    const admit = anchor + 240000, pokes = { count: n, max };
    log.push({ event: 'admit', at: admit, epoch: 2, items, pokes }, { event: 'step', at: admit + 500, anchorAt: admit + 500, epoch: 2 }, { event: 'poke', at: admit + 5000, epoch: 2, items, pokes, reason: 'eligible', context: 50000, usage: usage(49000) });
    transcript.push(message(poke(n, max), admit + 100 - at, 'user'), message('waiting', admit + 2000 - at));
    anchor = admit + 500;
  }
  transcript.push(message('<task-notification><task-id>task1</task-id>LONG_PROBE_DONE</task-notification>', back - 1000, 'user'), message('RETURNED', back, 'assistant', read), ...requests());
  return { transcriptPath: 'transcript.jsonl', debug: '', effort: [] as any[], waitingState: { state: 'warming', reason: 'eligible' }, returnedState: { state: 'on', reason: 'idle' }, transcript, log };
}
export function pair() {
  const control: any = mainLane(0, { read: 20000 });
  return { lanes: [mainLane(3), control] };
}
export function checkPair(input: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'keepwarm-pair-'));
  try { const path = join(dir, 'pair.json'); writeFileSync(path, JSON.stringify(input)); return spawnSync('python3', ['-I', script, path], { encoding: 'utf8' }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
export function python(body: string) {
  return spawnSync('python3', ['-I', '-B', '-c', `import importlib.util,sys,json,subprocess,tempfile,pathlib,types
spec=importlib.util.spec_from_file_location('runner',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${body}`, runner], { encoding: 'utf8', timeout: 5000 });
}
