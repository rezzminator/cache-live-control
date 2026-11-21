import { spawnSync } from 'node:child_process';
import type { EngineInterface, On, PluginOptions } from 'claude-code';
import { keepwarmState, keepwarmSessionStart, keepwarmPromptSubmit, keepwarmTurnStart, keepwarmTurnStep, keepwarmTurnComplete, keepwarmSessionCompact, keepwarmSessionEnd, registerKeepwarm } from '../../plugins/cache-live-control/hooks/keepwarm.ts';
function register(on: On, options: PluginOptions) {
  // This adapter alone, as plugin.ts registers it beside the other one.
  const s = keepwarmState(options);
  registerKeepwarm(on, s);
  on('session.start', ($, e, next) => keepwarmSessionStart($, e, next, s));
  on('prompt.submit', ($, e, next) => keepwarmPromptSubmit($, e, next, s));
  on('turn.start', ($, e, next) => keepwarmTurnStart($, e, next, s));
  on('turn.complete', ($, e, next) => keepwarmTurnComplete($, e, next, s));
  on('session.compact', ($, e, next) => keepwarmSessionCompact($, e, next, s));
  on('session.end', ($, e, next) => keepwarmSessionEnd($, e, next, s));
  on('turn.step', async function* ($, e, next) { return yield* keepwarmTurnStep($, e, next, s); });
}
export const pokeText = (n: string, bullets: string) => `Keep-warm poke ${n}: your prompt cache was about to expire, so this message keeps it warm while you wait on:\n${bullets}\nIf any of these is stale or was started by accident, stop it now. Otherwise reply with the single word \`waiting\` and nothing else: this turn only keeps the cache warm, and the plugin reads nothing from your reply.`;
export class Harness {
  debug: string[] = []; now = 1792247410124; status: string | undefined; statuses: (string | undefined)[] = []; toasts: string[] = [];
  handlers = new Map<string, { matcher: Record<string, unknown>; fn: Function }[]>();
  timers: { at: number; interval: number; active: boolean; fn: () => unknown }[] = [];
  messages: { role: string; text: string; toolUses: unknown[] }[] = [];
  sends: { to: { agentId: string }; text: string }[] = []; sendImpl: ((input: any) => Promise<any>) | null = null;
  submits: { text: string; asUser?: true }[] = []; submitImpl: ((input: any) => Promise<any>) | null = null; lists = 0; writes: string[] = []; paths: string[] = []; realRun = false; values = new Map<string, unknown>(); commands: unknown[] = [];
  draft = ''; id = 'session-1'; env: Record<string, string> = {}; loadError: unknown;
  agents = [{ id: 'a', status: 'waiting' }]; writeError: Error | null = null; writeImpl: (() => Promise<void>) | null = null; storeError: Error | null = null;
  pokeUsage = { input_tokens: 25, output_tokens: 3, cache_read_input_tokens: 49745, cache_creation_input_tokens: 807, model: 'claude-haiku-5-5' };
  engine: EngineInterface;
  constructor(options: PluginOptions = {}, env: Record<string, string> = {}) {
    this.env = { HOME: '/h', ...env };
    const timer = (ms: number, fn: () => unknown, interval: number) => {
      const t = { at: this.now + ms, fn, interval, active: true }; this.timers.push(t);
      return { cancel: () => { t.active = false; } };
    };
    this.engine = {
      plugin: { root: '/test-plugin' }, process: { run: async (argv: string[]) => argv[0] === '/bin/sh' && argv[3] === 'plugin-log' ? this.pluginLog(argv) : { exitCode: 0, stdout: '', stderr: '' } },
      env: { get: async (name: string) => this.env[name] },
      clock: { now: async () => this.now, after: (ms: number, fn: () => unknown) => timer(ms, fn, 0), every: (ms: number, fn: () => unknown) => timer(ms, fn, ms) },
      prompt: { read: async () => ({ text: this.draft }), submit: async (input: any) => { this.submits.push(input); return this.submitImpl ? this.submitImpl(input) : { text: input.text }; } },
      session: { id: async () => this.id, messages: async () => this.messages, send: async (input: any) => { this.sends.push(input); return this.sendImpl ? this.sendImpl(input) : { isDelivered: true }; } },
      agent: { list: async () => { this.lists++; return this.agents; } },
      store: { get: async (key: string) => { if (this.storeError) throw this.storeError; return this.values.get(key); }, set: async (key: string, value: unknown) => { if (this.storeError) throw this.storeError; this.values.set(key, value); }, keys: async () => { if (this.storeError) throw this.storeError; return [...this.values.keys()]; }, delete: async (key: string) => { if (this.storeError) throw this.storeError; this.values.delete(key); } },
      command: { register: (value: unknown) => this.commands.push(value) },
      ui: { log: (text: string) => this.debug.push(text), status: (text: string | undefined) => { this.status = text; this.statuses.push(text); }, toast: (text: string) => this.toasts.push(text), invalidate: () => {},  },
    } as unknown as EngineInterface;
    const on = ((event: string, ...args: unknown[]) => {
      const matcher = args.length > 1 ? args[0] as Record<string, unknown> : {};
      const fn = args.at(-1) as Function;
      this.handlers.set(event, [...this.handlers.get(event) ?? [], { matcher, fn }]);
      return { catch: () => {} };
    }) as unknown as On;
    try { register(on, options); } catch (error) { this.loadError = String(error); }
  }
  /** The plugin-log append script: rows are recorded as written; `realRun` also runs the script. */
  async pluginLog(argv: string[]) {
    if (this.writeError) throw this.writeError;
    if (this.writeImpl) await this.writeImpl();
    for (let i = 6; i < argv.length; i += 2) { this.paths.push(`${argv[4]}/${argv[i]}`); this.writes.push(argv[i + 1]!); }
    if (!this.realRun) return { exitCode: 0, stdout: '', stderr: '' };
    const done = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
    return { exitCode: done.status ?? 1, stdout: done.stdout, stderr: done.stderr };
  }
  async emit(event: string, input: any = {}, result: any = {}) {
    let forwarded: unknown;
    for (const { matcher, fn } of this.handlers.get(event) ?? []) {
      if (!Object.entries(matcher).every(([key, value]) => input[key] === value)) continue;
      forwarded = await fn(this.engine, input, async (e: unknown) => { forwarded = e; return result; });
    }
    return { result: forwarded, input };
  }
  async step(usage: any = { input_tokens: 2, output_tokens: 807, cache_read_input_tokens: 48952, cache_creation_input_tokens: 793, model: 'claude-haiku-5-5' }, agentId?: string, turnId = 't') {
    const e = { turnId, index: 0, model: 'claude-haiku-5-5', messageCount: 5, ...(agentId ? { agentId } : {}) };
    for (const { fn } of this.handlers.get('turn.step') ?? []) {
      const iterator = fn(this.engine, e, async function* (input: unknown) { yield { marker: input }; return { usage }; });
      while (!(await iterator.next()).done) { /* drain unchanged stream */ }
    }
  }
  async start() { await this.emit('session.start', { cwd: '.', surface: 'terminal', isInteractive: true }); }
  async stop(tasks: unknown = [{ id: 'a', type: 'subagent', status: 'running', description: 'Audit sk-test-123' }]) { return this.emit('classic.Stop', { background_tasks: tasks }); }
  async agentWait(id = 'sub', own = true, read?: number) {
    this.agents.push({ id, status: 'waiting' }); await this.emit('turn.start', { agentId: id, turnId: id, text: 'Do work' });
    await this.step(read ? { input_tokens: 2, output_tokens: 807, cache_read_input_tokens: read, cache_creation_input_tokens: 793, model: 'claude-haiku-5-5' } : undefined, id, id);
    if (own) await this.emit('tool.call', { agentId: id, tool: 'Bash', command: 'sleep 540', run_in_background: true, tool_use_id: 'tool-' + id }, { result: { backgroundTaskId: 'work-' + id } });
    await this.emit('classic.SubagentStop', { agent_id: id, background_tasks: [{ id: 'work-' + id, type: 'shell', status: 'running', description: 'Work', command: 'sleep 540' }] });
    await this.emit('turn.complete', { agentId: id, turnId: id, reason: 'answer', durationMs: 100, answer: 'WAITING' });
  }
  async warmReply(output = 3, id = 'sub') {
    const text = this.sends.findLast(s => s.to.agentId === id)!.text;
    await this.emit('turn.start', { agentId: id, turnId: 'warm-' + id, text });
    await this.emit('session.receive', { agentId: id, text, origin: { kind: 'coordinator', plugin: 'cache-live-control' } });
    const usage = { input_tokens: 25, output_tokens: output, cache_read_input_tokens: 49745, cache_creation_input_tokens: 807, model: 'claude-haiku-5-5' };
    await this.step(usage, id, 'warm-' + id);
    await this.emit('turn.complete', { agentId: id, turnId: 'warm-' + id, reason: 'answer', durationMs: 100, usage, answer: 'K' });
  }
  /** The main chat's visible poke turn as Claude Code runs it: the plugin's submit, the turn, its Stop and its completion. */
  async pokeReply({ usage = this.pokeUsage as any, tasks = undefined as unknown, reason = 'answer', order = 'stop-first', hook = true, compact = undefined as 'auto' | undefined } = {}) {
    const text = this.submits.at(-1)!.text, turnId = 'poke-' + this.submits.length;
    if (hook) await this.emit('prompt.submit', { text, origin: { kind: 'plugin', name: 'cache-live-control' } });
    await this.emit('turn.start', { turnId, text });
    if (compact) await this.emit('session.compact', { trigger: compact, messages: [] });
    await this.step(usage ?? this.pokeUsage, undefined, turnId);
    const complete = () => this.emit('turn.complete', { turnId, reason, durationMs: 100, ...(usage ? { usage } : {}), answer: 'waiting' });
    if (order === 'complete-first') { await complete(); await this.stop(tasks); } else { await this.stop(tasks); await complete(); }
  }
  async arm() { await this.start(); await this.step(); await this.stop(); }
  async advance(ms: number) {
    const target = this.now + ms;
    for (let i = 0; i < 1000; i++) {
      const t = this.timers.filter(t => t.active && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!t) break;
      this.now = t.at;
      if (t.interval) t.at += t.interval; else t.active = false;
      await t.fn(); await this.settle();
    }
    this.now = target; await this.settle();
  }
  async settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  get pending() { return this.timers.filter(t => t.active && !t.interval); }
  /** The decision rows the plugin logged, each the `detail` of its level row. */
  rows() { return this.writes.map(text => JSON.parse(text).detail); }
  snapshot(id = this.id) { const prefix = `session:${encodeURIComponent(id)}:`; return [...this.values.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value).at(-1) as any; }
  async command(args: string) { return (await this.emit('command.run', { command: 'keepwarm', args })).result as { text: string }; }
}
