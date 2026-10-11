import type { GuardMode } from './guard.ts';
import { parseCount, parsePrice, parseTokens } from './options.ts';
import { PARTIES, type Change, type Party, type Ttl } from './ttl.ts';

// `/cache` arguments to the one thing the command does. Words come in any
// order: a group is some parties and one TTL, party-first (`main 1h`, closed
// by its TTL) or TTL-first (`1h main agents`, open until the next TTL). Setting
// words (`raise 3`, `agents raise 2`, `guard block`, `handoff on`) are lifted
// out first, key first, and mix with the groups in any order.

/** The thresholds a command sets live; `null` switches one off. */
export type Settings = {
  /** `raise N|off`: the main chat's raiseAfterExpiries. */
  raise?: number | null;
  /** `agents raise N|off`: agentRaiseAfterExpiries. */
  agentRaise?: number | null;
  /** `agents waiting on|off`: agentRaiseWaiting. */
  agentWaiting?: boolean;
  /** `guard off|warn|block`: resumeGuard. */
  guard?: GuardMode;
  /** `guard floor N|Nk`: resumeGuardMinTokens. */
  guardFloor?: number;
  /** `guard price N|off`: resumeGuardPrice. */
  guardPrice?: number | null;
  /** `handoff on|off`. */
  handoff?: boolean;
};

export type Action =
  | { kind: 'status' }
  | { kind: 'set'; change: Change; settings?: Settings }
  | { kind: 'error'; message: string };

export const USAGE =
  'usage: /cache [main|agents] 5m|1h|auto — words in any order, e.g. /cache 1h agents · /cache main 5m agents 1h · settings: raise N|off · agents raise N|off · agents waiting on|off · guard off|warn|block · guard floor N|Nk · guard price N|off · handoff on|off';

const PARTY_WORDS: Readonly<Record<string, readonly Party[]>> = {
  main: ['main'],
  agent: ['agents'],
  agents: ['agents'],
  subagent: ['agents'],
  subagents: ['agents'],
  'sub-agent': ['agents'],
  'sub-agents': ['agents'],
  both: PARTIES,
  all: PARTIES,
};

/** A TTL word: the TTL, `null` for `auto`, undefined for anything else. */
function ttlWord(word: string): Ttl | null | undefined {
  if (word === '5m' || word === '1h') return word;
  if (word === 'auto') return null;
  return undefined;
}

type Group = { words: string[]; parties: Party[]; ttl?: Ttl | null; ttlWord?: string; ttlFirst: boolean };

function fail(reason: string): Action {
  return { kind: 'error', message: `nothing changed: ${reason}; ${USAGE}` };
}

const COUNT = 'a whole number of 1 or more, or off';

const AGENT_WORDS: ReadonlySet<string> = new Set(['agent', 'agents', 'subagent', 'subagents', 'sub-agent', 'sub-agents']);

/** Why a party word read as a setting's key cannot also be the party of a TTL beside it. */
function keyedParty(setting: string): string {
  const party = setting.split(' ')[0]!;
  return `"${setting}" is a setting, so ${party} is no party of the TTL beside it: name the TTL's party next to the TTL, e.g. ${party} 1h ${setting} …`;
}

/** Lifts the setting words out of `words`: the words left, and the settings, or why one is wrong. */
function takeSettings(words: readonly string[]): { rest: string[]; settings: Settings; partyKey?: string } | { error: string } {
  const rest: string[] = [];
  const settings: Settings = {};
  const given = new Set<string>();
  // The TTL group the words left so far would be in, as parseArgs groups them:
  // a party-led setting there would have taken a party word from that group.
  let group: 'none' | 'party-open' | 'party-closed' | 'ttl-first' = 'none';
  let partyKey: string | undefined;

  /** Sets one key; the same value again is allowed, another is an error. */
  function put<K extends keyof Settings>(key: K, label: string, value: Settings[K]): string | undefined {
    if (given.has(key) && settings[key] !== value) return `${label} is given twice`;
    given.add(key);
    settings[key] = value;
    return undefined;
  }

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const next = words[i + 1];
    const value = words[i + 2];
    const agents = AGENT_WORDS.has(word);
    let error: string | undefined;
    const partyLed = (word === 'main' && next === 'raise') || (agents && (next === 'raise' || next === 'waiting'));
    if (partyLed) {
      const setting = `${agents ? 'agents' : 'main'} ${next}`;
      if (group === 'ttl-first' || group === 'party-open') return { error: keyedParty(setting) };
      partyKey ??= setting;
    }
    if (word === 'raise' || (word === 'main' && next === 'raise') || (agents && next === 'raise')) {
      const forAgents = word !== 'raise' && agents;
      const at = word === 'raise' ? i + 1 : i + 2;
      const raw = words[at];
      const n = raw === 'off' ? null : raw === undefined ? undefined : parseCount(raw);
      if (n === undefined) return { error: `${forAgents ? 'agents raise' : 'raise'} needs ${COUNT}` };
      error = forAgents ? put('agentRaise', 'agents raise', n) : put('raise', 'raise', n);
      i = at;
    } else if (agents && next === 'waiting') {
      if (value !== 'on' && value !== 'off') return { error: 'agents waiting needs on or off' };
      error = put('agentWaiting', 'agents waiting', value === 'on');
      i += 2;
    } else if (word === 'guard') {
      if (next === 'off' || next === 'warn' || next === 'block') {
        error = put('guard', 'guard', next);
        i += 1;
      } else if (next === 'floor') {
        const tokens = value === undefined ? undefined : parseTokens(value);
        if (tokens === undefined) return { error: 'guard floor needs a number of tokens such as 60000 or 60k' };
        error = put('guardFloor', 'guard floor', tokens);
        i += 2;
      } else if (next === 'price') {
        const price = value === 'off' ? null : value === undefined ? undefined : parsePrice(value);
        if (price === undefined) return { error: 'guard price needs a number (USD per million input tokens) or off' };
        error = put('guardPrice', 'guard price', price);
        i += 2;
      } else {
        return { error: 'guard needs off, warn, block, floor N or price N' };
      }
    } else if (word === 'handoff') {
      if (next !== 'on' && next !== 'off') return { error: 'handoff needs on or off' };
      error = put('handoff', 'handoff', next === 'on');
      i += 1;
    } else {
      rest.push(word);
      if (PARTY_WORDS[word] !== undefined) group = group === 'ttl-first' ? 'ttl-first' : 'party-open';
      else if (ttlWord(word) !== undefined) group = group === 'party-open' ? 'party-closed' : 'ttl-first';
    }
    if (error !== undefined) return { error };
  }
  return { rest, settings, ...(partyKey === undefined ? {} : { partyKey }) };
}

export function parseArgs(args: string): Action {
  const all = args.trim().toLowerCase().split(/[\s,]+/).filter((w) => w !== '');
  if (all.length === 0) return { kind: 'status' };

  const taken = takeSettings(all);
  if ('error' in taken) return fail(taken.error);
  const { rest: words, settings } = taken;
  const withSettings = Object.keys(settings).length > 0 ? { settings } : {};

  const groups: Group[] = [];
  let open: Group | undefined;
  let lastTtl: string | undefined;
  for (const word of words) {
    const parties = PARTY_WORDS[word];
    const ttl = ttlWord(word);
    if (parties !== undefined) {
      lastTtl = undefined;
      // A party-first group closes at its TTL; the next party opens another.
      if (open === undefined || (!open.ttlFirst && open.ttl !== undefined)) {
        open = { words: [], parties: [], ttlFirst: false };
        groups.push(open);
      }
      open.words.push(word);
      open.parties.push(...parties);
    } else if (ttl !== undefined) {
      if (lastTtl !== undefined) return fail(`${lastTtl} and ${word} have no party between them`);
      lastTtl = word;
      if (open !== undefined && !open.ttlFirst && open.ttl === undefined) {
        open.ttl = ttl;
        open.ttlWord = word;
      } else {
        open = { words: [], parties: [], ttl, ttlWord: word, ttlFirst: true };
        groups.push(open);
      }
    } else {
      return fail(`"${word}" is not 5m, 1h, auto, main or agents`);
    }
  }

  const change: Change = {};
  for (const group of groups) {
    if (group.ttl === undefined) return fail(`${group.words.join(' ')} has no TTL`);
    if (group.parties.length === 0 && taken.partyKey !== undefined) {
      return fail(keyedParty(taken.partyKey));
    }
    const parties = group.parties.length > 0 ? group.parties : groups.length === 1 ? PARTIES : undefined;
    if (parties === undefined) return fail(`${group.ttlWord} names no party`);
    for (const party of parties) {
      const had = change[party];
      if (had !== undefined && had !== group.ttl) return fail(`${party} is given twice`);
      change[party] = group.ttl;
    }
  }
  return { kind: 'set', change, ...withSettings };
}
