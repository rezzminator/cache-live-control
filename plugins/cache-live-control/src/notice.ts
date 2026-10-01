import { isForced5m, resolveParty, type EnvSnapshot, type Ours } from './status.ts';
import type { Ttl } from './ttl.ts';

// The opt-in TTL notice (option ttlNotice): a short note the main chat's model
// reads beside a prompt, naming the TTL it runs on and how to delegate on it.
// Sub-agents never get it: they have no prompt of their own to carry it.

/**
 * The main chat's TTL as the next request uses it, or null when it cannot be
 * named (a variable Claude Code does not take): the note never claims one.
 * Automatic is assumed 1h, as warmth.ts's effectiveTtl assumes it.
 */
export function noticeTtl(env: EnvSnapshot, ours: Ours): Ttl | null {
  if (isForced5m(env.force5m)) return '5m';
  const r = resolveParty('main', env, ours);
  if (r.ttl === 'unknown') return null;
  if (r.ttl === 'automatic') return '1h';
  return r.ttl;
}

/** The note itself: an order the model acts on, its threshold named. */
export function noticeText(ttl: Ttl): string {
  if (ttl === '1h') {
    return "Prompt cache: this chat's cache lives 1 hour. Delegate: hand any task that needs more than about 30 tool calls to a sub-agent and wait for its return; do only quick reads, answers and small edits yourself. Waiting is free on a 1-hour cache and every token this chat writes costs double, so this overrides any default to do mid-size work directly.";
  }
  return "Prompt cache: this chat's cache lives 5 minutes. Work directly: do the task here with your own tool calls. A sub-agent run, background job or wait longer than about 4 minutes expires this chat's cache and forces a full rewrite of its context, so delegate only work that cannot fit in this chat, and keep every wait under 4 minutes.";
}

/**
 * Whether a compaction took the note out of the main chat's context, so the
 * next prompt carries it again: the main conversation's (no agentId), when it
 * ran (not skipped).
 */
export function forgetsNotice(e: { agentId?: string }, result: { skip?: string }): boolean {
  return e.agentId === undefined && result.skip === undefined;
}
