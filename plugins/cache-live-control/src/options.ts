import type { GuardMode } from './guard.ts';
import { isTtl, PARTIES, type Party, type Ttl } from './ttl.ts';

// The plugin's `userConfig`: a starting TTL per party, applied at session start
// unless a variable or a launcher's handoff (handoff.ts) comes first, and the
// opt-in TTL notice to the main chat (notice.ts), the main chat's auto-raise to
// 1h after N expired wake-ups (raise.ts), the sub-agent cache protection (the
// cold-resume guard, guard.ts) and the sub-agent progress summaries (summaries.ts).
// Every one is off unless set. No option raises the sub-agents' TTL: they run
// 5m unless `subagentTtl`, a typed `/cache agents` or an agent's own frontmatter says otherwise.

export const OPTION: Readonly<Record<Party, string>> = { main: 'mainTtl', agents: 'subagentTtl' };

// Every option is also read from the environment variable `CACHE_LIVE_CONTROL_{OPTION}`
// (the option in upper snake case): the variable beats the option, the option
// beats the default. A variable that is unset or blank (whitespace only) is
// absent; one that is bad is named and the default is used. A boolean reads
// 1, 0, true or false in any case; a list option takes a JSON array (none here).
// `mainTtl` and `subagentTtl` are read at session start by handoff.ts, which
// also owns their launcher spelling and the word `auto`.
export const ENV: Readonly<Record<string, string>> = {
  mainTtl: 'CACHE_LIVE_CONTROL_MAIN_TTL',
  subagentTtl: 'CACHE_LIVE_CONTROL_SUBAGENT_TTL',
  ttlNotice: 'CACHE_LIVE_CONTROL_TTL_NOTICE',
  raiseAfterExpiries: 'CACHE_LIVE_CONTROL_RAISE_AFTER_EXPIRIES',
  resumeGuard: 'CACHE_LIVE_CONTROL_RESUME_GUARD',
  resumeGuardMinTokens: 'CACHE_LIVE_CONTROL_RESUME_GUARD_MIN_TOKENS',
  resumeGuardPrice: 'CACHE_LIVE_CONTROL_RESUME_GUARD_PRICE',
  summaries: 'CACHE_LIVE_CONTROL_SUMMARIES',
};

/** The environment variables resolveOptions reads, by name: a value is a string or absent. */
export type EnvValues = Readonly<Record<string, string | undefined>>;

export type ResolvedOptions = {
  main?: Ttl;
  agents?: Ttl;
  /** ttlNotice: tell the main chat its cache TTL; absent when off. */
  notice?: true;
  /** raiseAfterExpiries: expired wake-ups before main goes to 1h; absent when off. */
  raiseAfter?: number;
  /** resumeGuard: warn or block a SendMessage to a cold, large agent; absent when off. */
  guard?: Exclude<GuardMode, 'off'>;
  /** resumeGuardMinTokens: the context below which a cold resume passes. */
  guardFloor?: number;
  /** resumeGuardPrice: USD per million base input tokens. */
  guardPrice?: number;
  /** summaries: `block` stops the sub-agent progress summaries from being asked of the model; absent when allowed. */
  summaries?: 'block';
  /** One line per option that was ignored, naming it and its value. */
  errors: string[];
};

/** A whole number of 1 or more, as a number or its digits; undefined for anything else. */
export function parseCount(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  const n = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** A number of tokens, `60000` or `60k` (`1.5k`), zero included; undefined for anything else. */
export function parseTokens(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().toLowerCase();
  if (/^[0-9]+$/.test(text)) return Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
  const thousands = /^([0-9]+(?:\.[0-9]+)?)k$/.exec(text);
  if (thousands === null) return undefined;
  const tokens = Math.round(Number(thousands[1]) * 1000);
  return Number.isSafeInteger(tokens) ? tokens : undefined;
}

/** A price above zero, as a number or its digits; undefined for anything else. */
export function parsePrice(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && /^[0-9]+(?:\.[0-9]+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A boolean option, or its string spelling (`true`, `false`, `1`, `0`): settings and environments can carry either. */
function readFlag(raw: unknown, label: string, errors: string[]): boolean {
  const flag = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  if (flag === true || flag === 'true' || flag === '1') return true;
  if (flag !== false && flag !== 'false' && flag !== '0' && flag !== '' && flag !== undefined) errors.push(`${label} ${JSON.stringify(raw)} ignored: use true, false, 1 or 0`);
  return false;
}

function isEmpty(raw: unknown): boolean {
  return raw === undefined || (typeof raw === 'string' && raw.trim() === '');
}

/** The value that decides an option and how an error names it: its variable when set, else the option. */
function decide(options: Readonly<Record<string, unknown>>, env: EnvValues, name: string): { raw: unknown; label: string } {
  const variable = ENV[name] as string;
  const set = env[variable];
  if (set !== undefined && set.trim() !== '') return { raw: set, label: variable };
  return { raw: options[name], label: `option ${name}` };
}

/** `options` is the plugin's configuration, `env` the variables above; a bad value of either is named in `errors` and leaves its option at the default. */
export function resolveOptions(options: Readonly<Record<string, unknown>>, env: EnvValues = {}): ResolvedOptions {
  const out: ResolvedOptions = { errors: [] };
  for (const party of PARTIES) {
    const name = OPTION[party];
    // A set variable decides the party at session start (handoff.ts), so the option is not judged.
    if ((env[ENV[name] as string] ?? '').trim() !== '') continue;
    const raw = options[name];
    if (raw === undefined || raw === '') continue;
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (isTtl(value)) out[party] = value;
    else out.errors.push(`option ${name} ${JSON.stringify(raw)} ignored: use 5m, 1h or empty`);
  }
  const notice = decide(options, env, 'ttlNotice');
  if (readFlag(notice.raw, notice.label, out.errors)) out.notice = true;

  const raiseAfter = decide(options, env, 'raiseAfterExpiries');
  if (!isEmpty(raiseAfter.raw)) {
    const n = parseCount(raiseAfter.raw);
    if (n !== undefined) out.raiseAfter = n;
    else out.errors.push(`${raiseAfter.label} ${JSON.stringify(raiseAfter.raw)} ignored: use a whole number of 1 or more, or empty`);
  }

  const guard = decide(options, env, 'resumeGuard');
  const mode = typeof guard.raw === 'string' ? guard.raw.trim().toLowerCase() : guard.raw;
  if (mode === 'warn' || mode === 'block') out.guard = mode;
  else if (mode !== 'off' && !isEmpty(guard.raw)) out.errors.push(`${guard.label} ${JSON.stringify(guard.raw)} ignored: use off, warn or block`);

  const floor = decide(options, env, 'resumeGuardMinTokens');
  if (!isEmpty(floor.raw)) {
    const tokens = parseTokens(floor.raw);
    if (tokens !== undefined) out.guardFloor = tokens;
    else out.errors.push(`${floor.label} ${JSON.stringify(floor.raw)} ignored: use a number of tokens such as 60000 or 60k, or empty`);
  }

  const price = decide(options, env, 'resumeGuardPrice');
  if (!isEmpty(price.raw)) {
    const usd = parsePrice(price.raw);
    if (usd !== undefined) out.guardPrice = usd;
    else out.errors.push(`${price.label} ${JSON.stringify(price.raw)} ignored: use a number (USD per million input tokens), or empty`);
  }

  const summaries = decide(options, env, 'summaries');
  const word = typeof summaries.raw === 'string' ? summaries.raw.trim().toLowerCase() : summaries.raw;
  if (word === 'block') out.summaries = 'block';
  else if (word !== 'allow' && !isEmpty(summaries.raw)) out.errors.push(`${summaries.label} ${JSON.stringify(summaries.raw)} ignored: use block, allow or empty`);
  return out;
}
