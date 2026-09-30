import { isEnvTruthy } from './launch.ts';
import { OPTION } from './options.ts';
import { isTtl, PARTIES, VARIABLE, type Party, type Ttl } from './ttl.ts';
import { warmthLabel, type Records } from './warmth.ts';

// What the TTL is for each party, and where it comes from.

/** The variables Claude Code reads for the TTL, as the process holds them now. */
export type EnvSnapshot = {
  main?: string;
  agents?: string;
  /** FORCE_PROMPT_CACHING_5M: when set, every request uses 5m. */
  force5m?: string;
  /** ENABLE_PROMPT_CACHING_1H: when set, 1h for both parties whose variable is unset. */
  enable1h?: string;
};

/**
 * What this plugin last set a party's variable to, and how: `/cache`, an
 * option, a launcher's handoff variable, or the launch's
 * ENABLE_PROMPT_CACHING_1H moved to the main chat.
 */
export type Via = 'command' | 'option' | 'handoff' | 'launch';
export type Ours = Partial<Record<Party, { value: Ttl; via: Via }>>;

const AUTOMATIC: Readonly<Record<Party, string>> = {
  main: 'settings, agent frontmatter or plan default',
  agents: "5m, unless subagentPromptCacheTtl or the agent's frontmatter sets it",
};

function credit(party: Party, via: Via): string {
  if (via === 'command') return 'set by /cache';
  if (via === 'option') return `option ${OPTION[party]}`;
  if (via === 'handoff') return 'set at launch';
  return 'ENABLE_PROMPT_CACHING_1H at launch, main chat only';
}

export type Resolved = {
  /** The TTL the variable forces, `automatic` when none, `unknown` for a value Claude Code does not take. */
  ttl: Ttl | 'automatic' | 'unknown';
  /** Where it comes from, for the status line. */
  source: string;
};

export function isForced5m(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && !/^(0|false|no|off)$/i.test(value.trim());
}

export function resolveParty(party: Party, env: EnvSnapshot, ours: Ours): Resolved {
  const raw = env[party];
  if (raw === undefined || raw === '') {
    if (isEnvTruthy(env.enable1h)) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H is set' };
    return { ttl: 'automatic', source: AUTOMATIC[party] };
  }
  if (!isTtl(raw)) return { ttl: 'unknown', source: `${VARIABLE[party]}=${JSON.stringify(raw)} is not 5m or 1h` };
  const mine = ours[party];
  if (mine?.value === raw) return { ttl: raw, source: credit(party, mine.via) };
  return { ttl: raw, source: `${VARIABLE[party]} set outside this plugin` };
}

function forceWarning(env: EnvSnapshot): string[] {
  return isForced5m(env.force5m) ? [`warning: FORCE_PROMPT_CACHING_5M=${JSON.stringify(env.force5m)} is set, so every request uses 5m`] : [];
}

/** Each party's latest request, for the warmth `/cache` shows beside it. */
export type Warmth = { records: Records; now: number };

/** `/cache` with no arguments: each party's TTL, its source and warmth, one line. */
export function formatStatus(env: EnvSnapshot, ours: Ours, optionErrors: readonly string[] = [], warmth?: Warmth): string {
  const parties = PARTIES.map((party) => {
    const r = resolveParty(party, env, ours);
    const warm = warmth === undefined ? '' : `, ${warmthLabel(party, warmth.records[party], warmth.now)}`;
    return `${party} ${r.ttl} (${r.source}${warm})`;
  });
  return `${[...parties, ...forceWarning(env), ...optionErrors].join(' · ')}`;
}

/** After a change: the new state, one short line. */
export function formatState(env: EnvSnapshot, ours: Ours): string {
  const parties = PARTIES.map((party) => `${party} ${resolveParty(party, env, ours).ttl}`);
  return `${[...parties, ...forceWarning(env)].join(' · ')}`;
}
