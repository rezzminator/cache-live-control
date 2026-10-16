import { ENV, type ResolvedOptions } from './options.ts';
import type { EnvSnapshot } from './status.ts';
import { PARTIES, type Change, type Party, type Ttl } from './ttl.ts';

// The starting TTLs as variables, read once at session start: the options
// `mainTtl` and `subagentTtl` as `CACHE_LIVE_CONTROL_MAIN_TTL` and
// `CACHE_LIVE_CONTROL_SUBAGENT_TTL` (a launcher's handoff is the same
// variables; `CACHE_LIVE_CONTROL_AGENTS_TTL` is its older spelling for the
// sub-agents). They are consumed after the read, so the plugin stays the only
// writer of Claude Code's own TTL variables and a program the chat starts
// never inherits them.

/** Per party, the variables in the order the first set one decides. */
export const HANDOFF: Readonly<Record<Party, readonly string[]>> = {
  main: [ENV['mainTtl'] as string],
  agents: [ENV['subagentTtl'] as string, 'CACHE_LIVE_CONTROL_AGENTS_TTL'],
};

/** The handoff variables as the process holds them at session start, by variable name. */
export type HandoffSnapshot = Readonly<Record<string, string | undefined>>;

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
 * variable set at launch (kept), the handoff variable, the plugin option. A
 * handoff `auto` wins too, leaving the party automatic. A handoff variable
 * that is bad is named and the party stays automatic: the option does not
 * stand in for it.
 */
export function startPlan(handoff: HandoffSnapshot, options: ResolvedOptions, env: EnvSnapshot): StartPlan {
  const plan: StartPlan = { change: {}, via: {}, errors: [] };
  for (const party of PARTIES) {
    const variable = HANDOFF[party].find((name) => (handoff[name] ?? '').trim() !== '');
    const raw = variable === undefined ? undefined : handoff[variable];
    const value = handoffValue(raw);
    if (value === 'bad') plan.errors.push(`${variable} ${JSON.stringify(raw)} ignored: use 5m, 1h or auto`);
    if ((env[party] ?? '') !== '' || value === 'bad') continue;
    if (value !== undefined) {
      plan.change[party] = value;
      plan.via[party] = 'handoff';
    } else if (options[party] !== undefined) {
      plan.change[party] = options[party];
      plan.via[party] = 'option';
    }
  }
  return plan;
}
