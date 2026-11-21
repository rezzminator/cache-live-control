import type { ModelUsage } from 'claude-code';
import type { Ttl } from './ttl.ts';
export type Usage = Pick<ModelUsage, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'>;
export interface BudgetLedger { context: number; ttl: Ttl; spent: number; warms: number; allowance: number; protecting: number; remaining: number }
export interface ClosedLedger { elapsedMs: number; readPercent: number | null; netSaved: number | null; reason: 'estimated' | 'early' | 'miss' | 'unknown' }
export interface SessionLedger { spent: number; warms: number; episodes: number; estimatedNet: number; unknown: number }
const rounded = (n: number): number => Math.round(n * 1e6) / 1e6;
export function rewriteSaved({ context, ttl }: { context: number; ttl: Ttl }): number { return rounded(context * (ttl === '5m' ? 1.15 : 1.9)); }
export function warmSpend(usage: Usage): number { return rounded(usage.cache_read_input_tokens * 0.1 + usage.cache_creation_input_tokens * 2 + usage.input_tokens + usage.output_tokens * 5); }
/** A poke is a real turn at the thread's own effort, thinking included: the observed spend of this thread's previous poke, never under a
 * conservative floor — the context read, the unwritten tail plus the poke (150) written, and a 1,000-token reply. */
export function pokeForecast({ context, tail, previous }: { context: number; tail: number; previous: number | null }): number { return rounded(Math.max(context * 0.1 + (tail + 150) * 2 + 1000 * 5, previous ?? 0)); }
/** A sub-agent poke also wakes its parent: Claude Code hands the parent an interim notification, one real parent turn per poke. */
export function wakeForecast({ parentContext }: { parentContext: number }): number { return rounded(parentContext * 0.1 + (150 + 1000) * 2 + 1000 * 5); }
export function allow({ spent, forecast, saved }: { spent: number; forecast: number; saved: number }): boolean { return [spent, forecast, saved].every(n => Number.isFinite(n) && n >= 0) && spent + forecast <= saved; }
export function budgetLedger({ context, ttl, spent, warms }: { context: number; ttl: Ttl; spent: number; warms: number }): BudgetLedger {
  const allowance = rewriteSaved({ context, ttl });
  return { context, ttl, spent, warms, allowance, protecting: rounded(context * (ttl === '5m' ? 1.25 : 2)), remaining: rounded(allowance - spent) };
}
export function closeLedger(input: { ledger: BudgetLedger; waitStartedAt: number; originalExpiryAt: number; returnedAt: number; usage: Usage | null; samePrefix: boolean | null; settled?: boolean }): ClosedLedger {
  const { ledger, usage } = input, elapsedMs = Math.max(0, input.returnedAt - input.waitStartedAt);
  const valid = usage !== null && [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].every(n => Number.isFinite(n) && n >= 0);
  const total = valid ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0;
  const readPercent = valid && total > 0 ? usage.cache_read_input_tokens / total * 100 : null;
  if (readPercent === null || input.samePrefix !== true || input.settled === false) return { elapsedMs, readPercent, netSaved: null, reason: 'unknown' };
  if (input.returnedAt < input.originalExpiryAt) return { elapsedMs, readPercent, netSaved: -ledger.spent, reason: 'early' };
  if (readPercent < 90) return { elapsedMs, readPercent, netSaved: -ledger.spent, reason: 'miss' };
  return { elapsedMs, readPercent, netSaved: rounded(ledger.allowance - ledger.spent), reason: 'estimated' };
}
export function emptySessionLedger(): SessionLedger { return { spent: 0, warms: 0, episodes: 0, estimatedNet: 0, unknown: 0 }; }
export function recordWarm(session: SessionLedger, usage: Usage): SessionLedger { return { ...session, spent: rounded(session.spent + warmSpend(usage)), warms: session.warms + 1 }; }
export function recordOutcome(session: SessionLedger, outcome: ClosedLedger): SessionLedger { return { ...session, episodes: session.episodes + 1, estimatedNet: rounded(session.estimatedNet + (outcome.netSaved ?? 0)), unknown: session.unknown + (outcome.netSaved === null ? 1 : 0) }; }
