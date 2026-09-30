import { isTtl, PARTIES, type Party, type Ttl } from './ttl.ts';

// The plugin's `userConfig`: a starting TTL per party, applied at session start
// unless a variable or a launcher's handoff (handoff.ts) comes first.

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
