import type { Ttl, TtlSource } from './ttl.ts';
import type { WaitItem } from './waits.ts';
import type { BudgetLedger, ClosedLedger, SessionLedger } from './budget.ts';
import type { ReasonCode } from './decision.ts';
export type StatusItem = Pick<WaitItem, 'kind' | 'label'> & { firstSeenAt: number };
export interface PokeLimit { count: number; max: number }
export interface StatusView { enabled: boolean; source: 'launch' | 'session'; reason: ReasonCode; pokes?: PokeLimit; items: readonly StatusItem[]; now: number; warms: number; nextInMs: number; ttl: Ttl; ttlSource: TtlSource; context: number | null; ledger: BudgetLedger | null; session: SessionLedger; lastOutcome: ClosedLedger | null; detail?: string; warnings?: readonly string[] }
const prefix = 'keep-warm · ';
function duration(ms: number): string { const minutes = Math.max(0, Math.floor(ms / 60000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`; }
function label(item: Pick<WaitItem, 'kind' | 'label'> | undefined): string { return item ? `${item.kind} "${item.label}"` : 'work'; }
function limit(pokes: PokeLimit | undefined): string { return pokes ? ` ${pokes.count}/${pokes.max}` : ''; }
const reasons: Record<ReasonCode, string> = {
  'agent-not-waiting': 'stopped: sub-agent is not waiting', eligible: 'warming', off: 'off', busy: 'not warming: turn running', stale: 'stopped: stale wait', 'in-flight': 'poke in flight',
  'inventory-unknown': 'stopped: this Claude Code gives the Stop hook no background_tasks', 'nothing-pending': 'not warming: nothing tracked pending', ended: 'stopped: work ended',
  'usage-unknown': 'not warming: no main request seen since the plugin loaded', 'usage-invalid': 'not warming: invalid cache usage or clock', small: 'not warming: context too small',
  '1h-unproven': 'not warming: 1h refresh unproven', 'cache-cold': 'not warming: cache cold', 'expiry-safety': 'not warming: too close to expiry',
  'wake-unknown': 'not warming: wake capability unknown', 'cannot-wake': 'not warming: work cannot wake chat', 'poke-limit': 'stopped: poke limit reached',
  imminent: 'not warming: work expected before expiry', budget: 'stopped: next warm exceeds budget', marginal: 'not warming: forecast saving marginal',
  'poke-failed': 'stopped: poke failed', 'timer-failed': 'stopped: timer failed', resumed: 'resumed: fresh tracked Stop required', idle: 'on, idle: waiting for tracked work',
};
const eq = (n: number): string => `${Math.round(n / 100) / 10}k-eq`;
export function formatLedger(ledger: BudgetLedger | null, session: SessionLedger): string {
  return `${ledger ? `${ledger.warms} warms · spent ≈ ${eq(ledger.spent)} / ${eq(ledger.allowance)} · protecting ≈ ${eq(ledger.protecting)} rewrite · ` : ''}session ${session.warms} warms, spent ≈ ${eq(session.spent)}, estimated net ≈ ${eq(session.estimatedNet)}${session.unknown ? ` (${session.unknown} unknown)` : ''}`;
}
export function formatState(view: StatusView): string {
  return `${prefix}${view.enabled ? 'on' : 'off'} (${view.source === 'launch' ? 'launch default' : 'session override'}) · ${reasons[view.reason]}${view.reason === 'poke-limit' ? limit(view.pokes) : ''}${view.detail ? ` (${view.detail})` : ''} [${view.reason}] · ${view.items.length ? `${label(view.items[0])}${view.items.length > 1 ? ` +${view.items.length - 1} more` : ''} · ${duration(view.now - Math.min(...view.items.map(i => i.firstSeenAt)))} · ETA unknown` : 'no current wait'} · ${view.context ?? 'unknown'} tokens · ${formatLedger(view.ledger, view.session)}${view.lastOutcome ? ` · last: ${formatOutcome(view.lastOutcome)}` : ''}${view.warnings?.length ? ' · ' + view.warnings.join(' · ') : ''}`;
}
type StateEnv = Partial<Record<'CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR' | 'XDG_STATE_HOME' | 'HOME', string>>;
/** The sessions directory: CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR, else XDG_STATE_HOME's, else HOME's. The writer takes only an absolute one, so a
 * relative value is skipped and named in `warning`; with none left the state file is off. */
export function stateDirectory(env: StateEnv): { dir: string; warning?: string } {
  const bad: string[] = [];
  const pick = (name: keyof StateEnv, suffix: string) => {
    const value = env[name]?.trim();
    if (!value) return undefined;
    if (value.startsWith('/')) return value + suffix;
    bad.push(name); return undefined;
  };
  const dir = pick('CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR', '') ?? pick('XDG_STATE_HOME', '/cache-live-control/keepwarm/sessions') ?? pick('HOME', '/.local/state/cache-live-control/keepwarm/sessions') ?? '';
  if (!bad.length && dir) return { dir };
  return { dir, warning: `state directory: ${bad.length ? bad.join(', ') + ' not absolute' : 'HOME unset'}; ${dir ? 'using ' + dir : 'session state off'}` };
}
/** Public v1 session projection. No task labels or sub-agent state leave this view. */
export function sessionState(view: StatusView, sessionId: string) {
  const reason = view.enabled ? view.reason : 'off';
  const state = reason === 'off' ? 'off' : ['eligible', 'in-flight'].includes(reason) && view.items.length > 0 ? 'warming' : ['poke-limit', 'budget', 'poke-failed', 'timer-failed', 'stale', 'ended'].includes(reason) ? 'stopped' : 'on';
  return { v: 1, sessionId, updatedAt: view.now, enabled: view.enabled, source: view.source, state, reason, pokes: view.pokes ?? null, nextAt: state === 'warming' && view.nextInMs > 0 ? view.now + view.nextInMs : null, protectingTokensEq: view.ledger?.protecting ?? null };
}
export function formatOutcome(outcome: ClosedLedger): string {
  return `kept warm across ${duration(outcome.elapsedMs)} · return read ${outcome.readPercent === null ? 'unknown' : outcome.readPercent.toFixed(1) + '%'} from cache · estimated net saved ≈ ${outcome.netSaved === null ? 'unknown' : eq(outcome.netSaved)}`;
}

export interface PokeItem { id: string; kind: string; label: string; firstSeenAt: number }
/** The visible poke, the same in the main chat and a sub-agent: one bullet per pending item, its real id and sanitized label. */
export function pokeMessage({ n, max, now, items }: { n: number; max: number; now: number; items: readonly PokeItem[] }): string {
  const bullets = items.map(i => `- ${i.kind === 'monitor' ? 'Monitor' : i.kind} \`${i.id}\`: ${i.label || 'your background work'}, pending ${duration(now - i.firstSeenAt)}`);
  return [`Keep-warm poke ${n}/${max}: your prompt cache was about to expire, so this message keeps it warm while you wait on:`, ...bullets, 'If any of these is stale or was started by accident, stop it now. Otherwise reply with the single word `waiting` and nothing else: this turn only keeps the cache warm, and the plugin reads nothing from your reply.'].join('\n');
}
