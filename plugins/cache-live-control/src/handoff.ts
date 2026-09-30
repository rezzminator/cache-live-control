import type { ResolvedOptions } from './options.ts';
import type { EnvSnapshot } from './status.ts';
import { PARTIES, type Change, type Party, type Ttl } from './ttl.ts';

// A launcher's starting TTLs, handed over through two plugin-owned variables
// so the plugin stays the only writer of Claude Code's own TTL variables.

export const HANDOFF: Readonly<Record<Party, string>> = {
  main: 'CACHE_LIVE_CONTROL_MAIN_TTL',
  agents: 'CACHE_LIVE_CONTROL_AGENTS_TTL',
};

/** The handoff variables as the process holds them at session start. */
export type HandoffSnapshot = Partial<Record<Party, string>>;

export type StartPlan = {
  /** What to set; `null` leaves the party automatic (a handoff `auto`). */
  change: Change;
  /** Who chose each party in `change`. */
  via: Partial<Record<Party, 'handoff' | 'option'>>;
  /** One line per ignored handoff value, naming the variable and its value. */
  errors: string[];
};

/** A handoff value: a TTL, `null` for `auto`, undefined for unset or empty. */
function handoffValue(raw: string | undefined): Ttl | null | undefined | 'bad' {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return undefined;
  if (value === '5m' || value === '1h') return value;
  if (value === 'auto') return null;
  return 'bad';
}

/**
 * Session start, per party, the first that is set wins: Claude Code's own
 * variable set at launch (kept), the launcher's handoff variable, the
 * plugin option. A handoff `auto` wins too, leaving the party automatic.
 */
export function startPlan(handoff: HandoffSnapshot, options: ResolvedOptions, env: EnvSnapshot): StartPlan {
  const plan: StartPlan = { change: {}, via: {}, errors: [] };
  for (const party of PARTIES) {
    const value = handoffValue(handoff[party]);
    if (value === 'bad') plan.errors.push(`${HANDOFF[party]} ${JSON.stringify(handoff[party])} ignored: use 5m, 1h or auto`);
    if ((env[party] ?? '') !== '') continue;
    if (value !== undefined && value !== 'bad') {
      plan.change[party] = value;
      plan.via[party] = 'handoff';
    } else if (options[party] !== undefined) {
      plan.change[party] = options[party];
      plan.via[party] = 'option';
    }
  }
  return plan;
}
