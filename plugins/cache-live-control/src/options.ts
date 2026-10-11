import type { GuardMode } from './guard.ts';
import { isTtl, PARTIES, type Party, type Ttl } from './ttl.ts';

// The plugin's `userConfig`: a starting TTL per party, applied at session start
// unless a variable or a launcher's handoff (handoff.ts) comes first, and the
// opt-in TTL notice to the main chat (notice.ts), the auto-raise to 1h after N
// expired wake-ups (raise.ts), and the sub-agent cache protection: the agents'
// auto-raise (agentraise.ts), the cold-resume guard (guard.ts) and the agent
// handoff (agenthandoff.ts). Every one is off unless set.

export const OPTION: Readonly<Record<Party, string>> = { main: 'mainTtl', agents: 'subagentTtl' };

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
  /** agentRaiseWaiting: hold the agents at 1h while an agent waits on background work; absent when off. */
  agentRaiseWaiting?: true;
  /** agentRaiseAfterExpiries: expired requests of one agent before the agents are held at 1h for it; absent when off. */
  agentRaiseAfter?: number;
  /** handoff: ask each spawned sub-agent for a handoff file; absent when off. */
  handoff?: true;
  /** handoffDir: where those files go; absent for the plugin's own data directory. */
  handoffDir?: string;
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
  return thousands === null ? undefined : Math.round(Number(thousands[1]) * 1000);
}

/** A price above zero, as a number or its digits; undefined for anything else. */
export function parsePrice(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && /^[0-9]+(?:\.[0-9]+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A boolean option, or its string spelling: settings and environments can carry either. */
function readFlag(options: Readonly<Record<string, unknown>>, name: string, errors: string[]): boolean {
  const raw = options[name];
  const flag = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  if (flag === true || flag === 'true') return true;
  if (flag !== false && flag !== 'false' && flag !== '' && flag !== undefined) errors.push(`option ${name} ${JSON.stringify(raw)} ignored: use true or false`);
  return false;
}

function isEmpty(raw: unknown): boolean {
  return raw === undefined || (typeof raw === 'string' && raw.trim() === '');
}

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
  if (readFlag(options, 'ttlNotice', out.errors)) out.notice = true;

  for (const [name, key] of [['raiseAfterExpiries', 'raiseAfter'], ['agentRaiseAfterExpiries', 'agentRaiseAfter']] as const) {
    const raw = options[name];
    if (isEmpty(raw)) continue;
    const n = parseCount(raw);
    if (n !== undefined) out[key] = n;
    else out.errors.push(`option ${name} ${JSON.stringify(raw)} ignored: use a whole number of 1 or more, or empty`);
  }

  const guard = options['resumeGuard'];
  const mode = typeof guard === 'string' ? guard.trim().toLowerCase() : guard;
  if (mode === 'warn' || mode === 'block') out.guard = mode;
  else if (mode !== 'off' && !isEmpty(guard)) out.errors.push(`option resumeGuard ${JSON.stringify(guard)} ignored: use off, warn or block`);

  const floor = options['resumeGuardMinTokens'];
  if (!isEmpty(floor)) {
    const tokens = parseTokens(floor);
    if (tokens !== undefined) out.guardFloor = tokens;
    else out.errors.push(`option resumeGuardMinTokens ${JSON.stringify(floor)} ignored: use a number of tokens such as 60000 or 60k, or empty`);
  }

  const price = options['resumeGuardPrice'];
  if (!isEmpty(price)) {
    const usd = parsePrice(price);
    if (usd !== undefined) out.guardPrice = usd;
    else out.errors.push(`option resumeGuardPrice ${JSON.stringify(price)} ignored: use a number (USD per million input tokens), or empty`);
  }

  if (readFlag(options, 'agentRaiseWaiting', out.errors)) out.agentRaiseWaiting = true;
  if (readFlag(options, 'handoff', out.errors)) out.handoff = true;

  const dir = options['handoffDir'];
  // Absolute only: the sub-agent writes the file from its own working directory, the plugin looks for it from another.
  if (typeof dir === 'string' && dir.trim().startsWith('/')) out.handoffDir = dir.trim();
  else if (!isEmpty(dir)) out.errors.push(`option handoffDir ${JSON.stringify(dir)} ignored: use an absolute directory path, or empty`);
  return out;
}
