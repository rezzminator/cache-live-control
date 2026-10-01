import { isForced5m, resolveParty, type EnvSnapshot, type Ours } from './status.ts';
import type { Ttl } from './ttl.ts';

// The opt-in TTL notice (option ttlNotice): a short note the main chat's model
// reads beside a prompt, naming the TTL it runs on and how to delegate on it.
// Sub-agents never get it: they have no prompt of their own to carry it.

/** The TTL the note names, and why the main chat runs on it. */
export type Notice = { ttl: Ttl; why: string };

/**
 * The main chat's TTL as the next request uses it, or null when it cannot be
 * named (a variable Claude Code does not take): the note never claims one.
 * Automatic is assumed 1h, as warmth.ts's effectiveTtl assumes it.
 */
export function noticeTtl(env: EnvSnapshot, ours: Ours): Notice | null {
  if (isForced5m(env.force5m)) return { ttl: '5m', why: 'FORCE_PROMPT_CACHING_5M is set' };
  const r = resolveParty('main', env, ours);
  if (r.ttl === 'unknown') return null;
  if (r.ttl === 'automatic') return { ttl: '1h', why: 'automatic, assumed 1h: the subscription default; an API-key plan runs 5m' };
  return { ttl: r.ttl, why: r.source };
}

/** The note itself. */
export function noticeText(n: Notice): string {
  if (n.ttl === '1h') {
    return `Prompt cache: this main chat runs on a 1-hour TTL (${n.why}). A wait of up to an hour (a sub-agent's run, a background job) keeps this chat's cache warm, and every token written here costs 2× the base input price at 1h against 1.25× at 5m, so keep this context lean: delegate multi-step work to sub-agents and wait for their returns. A later cache note replaces this one.`;
  }
  return `Prompt cache: this main chat runs on a 5-minute TTL (${n.why}). Any wait over 5 minutes (a sub-agent's run, a background job, a scheduled wake-up) lets this chat's cache expire, and the next request writes the whole context again. Do work that fits in this chat yourself; delegate only work too large for it, and never wait, poll or schedule a wake-up more than 5 minutes out expecting the cache to hold. A later cache note replaces this one.`;
}

/**
 * Whether a compaction took the note out of the main chat's context, so the
 * next prompt carries it again: the main conversation's (no agentId), when it
 * ran (not skipped).
 */
export function forgetsNotice(e: { agentId?: string }, result: { skip?: string }): boolean {
  return e.agentId === undefined && result.skip === undefined;
}
