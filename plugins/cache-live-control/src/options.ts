import { isTtl, PARTIES, type Change, type Party, type Ttl } from './ttl.ts';
import type { EnvSnapshot } from './status.ts';

// The plugin's `userConfig`: a starting TTL per party, applied at session start.

export const OPTION: Readonly<Record<Party, string>> = { main: 'mainTtl', agents: 'subagentTtl' };

export type ResolvedOptions = {
  main?: Ttl;
  agents?: Ttl;
  /** One line per option that was ignored, naming it and its value. */
  errors: string[];
};

export function resolveOptions(options: Readonly<Record<string, unknown>>): ResolvedOptions {
  const out: ResolvedOptions = { errors: [] };
  for (const party of PARTIES) {
    const name = OPTION[party];
    const raw = options[name];
    if (raw === undefined || raw === '') continue;
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (isTtl(value)) out[party] = value;
    else out.errors.push(`option ${name} ${JSON.stringify(raw)} ignored: use 5m, 1h or empty`);
  }
  return out;
}

/**
 * What the options set at session start: a party whose variable is already
 * set (at launch, or by `/cache` earlier in this process) keeps it, since a
 * variable is the more specific choice for this chat.
 */
export function optionChange(options: ResolvedOptions, env: EnvSnapshot): Change {
  const change: Change = {};
  for (const party of PARTIES) {
    const value = options[party];
    if (value !== undefined && (env[party] ?? '') === '') change[party] = value;
  }
  return change;
}
