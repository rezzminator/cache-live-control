export type CompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute' | 'unknown';
export type CompactOutcome = 'installed' | 'skipped' | 'failed';
export interface CompactFacts { trigger: CompactTrigger; agentId?: string; outcome?: CompactOutcome }
const TRIGGERS: readonly string[] = ['manual', 'auto', 'plugin', 'precompute'];
/** The metadata of one `session.compact` the log keeps: its trigger (an unrecognised one reads `unknown`) and, for a sub-agent's or a fork's own loop, its agentId. Never the instructions or the messages. */
export function compactFacts(input: { trigger?: unknown; agentId?: unknown }): CompactFacts {
  const trigger = typeof input.trigger === 'string' && TRIGGERS.includes(input.trigger) ? input.trigger as CompactTrigger : 'unknown';
  return { trigger, ...(typeof input.agentId === 'string' && input.agentId ? { agentId: input.agentId } : {}) };
}
/** Which send anchors a compaction invalidates: `precompute` installs nothing (its result waits for the next compaction), so none; a sub-agent's or a fork's own compaction (`agentId`) rewrites only that loop's prefix, never the main chat's; every other trigger, an unknown one included, resets the main chat. */
export function compactReset(facts: CompactFacts): 'none' | 'main' | 'agent' { return facts.trigger === 'precompute' ? 'none' : facts.agentId ? 'agent' : 'main'; }
/** What a compaction came to, read from what `next(e)` resolved to: a `skip` string (a plugin's veto, a classic PreCompact block) installs nothing. */
export function compactOutcome(result: unknown): CompactOutcome {
  return typeof (result as { skip?: unknown } | null | undefined)?.skip === 'string' ? 'skipped' : 'installed';
}
