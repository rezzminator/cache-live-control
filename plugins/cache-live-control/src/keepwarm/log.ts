import type { Ttl, TtlSource } from './ttl.ts';
import type { BudgetLedger, SessionLedger, Usage } from './budget.ts';
import type { CompactOutcome, CompactTrigger } from './compact.ts';
export interface LogRow { kind?: 'subagent'; agentId?: string; trigger?: CompactTrigger; outcome?: CompactOutcome; at: number; anchorAt?: number; event: string; epoch: number; items: readonly { id: string; kind: string }[]; ttl: Ttl; ttlSource: TtlSource; context: number | null; usage?: Usage; spent: number; reason?: string; warms?: number; pokes?: { count: number; max: number }; ledger?: BudgetLedger; session?: SessionLedger }
/** The metadata-only copy of a row: a field the producer adds beyond LogRow never reaches the log. */
export function metaRow(r: LogRow): LogRow {
  return ({ at: r.at, ...(r.kind === 'subagent' && r.agentId ? { kind: r.kind, agentId: r.agentId } : {}), ...(r.trigger === undefined ? {} : { trigger: r.trigger, ...(r.kind !== 'subagent' && r.agentId ? { agentId: r.agentId } : {}), ...(r.outcome ? { outcome: r.outcome } : {}) }), ...(r.anchorAt === undefined ? {} : { anchorAt: r.anchorAt }), event: r.event, epoch: r.epoch, items: r.items.map(({ id, kind }) => ({ id, kind })), ttl: r.ttl, ttlSource: r.ttlSource, context: r.context, spent: r.spent,
    ...(r.reason === undefined ? {} : { reason: r.reason }), ...(r.warms === undefined ? {} : { warms: r.warms }), ...(r.pokes ? { pokes: { count: r.pokes.count, max: r.pokes.max } } : {}),
    ...(r.usage ? { usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, cache_read_input_tokens: r.usage.cache_read_input_tokens, cache_creation_input_tokens: r.usage.cache_creation_input_tokens } } : {}),
    ...(r.ledger ? { ledger: { context: r.ledger.context, ttl: r.ledger.ttl, spent: r.ledger.spent, warms: r.ledger.warms, allowance: r.ledger.allowance, protecting: r.ledger.protecting, remaining: r.ledger.remaining } } : {}),
    ...(r.session ? { session: { spent: r.session.spent, warms: r.session.warms, episodes: r.session.episodes, estimatedNet: r.session.estimatedNet, unknown: r.session.unknown } } : {}),
  });
}
