import { isTtl, PARTIES, type Party, type Ttl } from './ttl.ts';

// The plugin's `userConfig`: a starting TTL per party, applied at session start
// unless a variable or a launcher's handoff (handoff.ts) comes first, and the
// opt-in TTL notice to the main chat (notice.ts).

export const OPTION: Readonly<Record<Party, string>> = { main: 'mainTtl', agents: 'subagentTtl' };

export type ResolvedOptions = {
  main?: Ttl;
  agents?: Ttl;
  /** ttlNotice: tell the main chat its cache TTL; absent when off. */
  notice?: true;
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
  const notice = options['ttlNotice'];
  // A boolean, or its string spelling: settings and environments can carry either.
  const flag = typeof notice === 'string' ? notice.trim().toLowerCase() : notice;
  if (flag === true || flag === 'true') out.notice = true;
  else if (flag !== false && flag !== 'false' && flag !== '' && flag !== undefined) {
    out.errors.push(`option ttlNotice ${JSON.stringify(notice)} ignored: use true or false`);
  }
  return out;
}
