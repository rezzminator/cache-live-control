import { PARTIES, type Change, type Party, type Ttl } from './ttl.ts';

// `/cache` arguments to the one thing the command does. Words come in any
// order: a group is some parties and one TTL, party-first (`main 1h`, closed
// by its TTL) or TTL-first (`1h main agents`, open until the next TTL).

export type Action =
  | { kind: 'status' }
  | { kind: 'set'; change: Change }
  | { kind: 'error'; message: string };

export const USAGE =
  'usage: /cache [main|agents] 5m|1h|auto — words in any order, e.g. /cache 1h agents · /cache main 5m agents 1h';

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

export function parseArgs(args: string): Action {
  const words = args.trim().toLowerCase().split(/[\s,]+/).filter((w) => w !== '');
  if (words.length === 0) return { kind: 'status' };

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
    const parties = group.parties.length > 0 ? group.parties : groups.length === 1 ? PARTIES : undefined;
    if (parties === undefined) return fail(`${group.ttlWord} names no party`);
    for (const party of parties) {
      const had = change[party];
      if (had !== undefined && had !== group.ttl) return fail(`${party} is given twice`);
      change[party] = group.ttl;
    }
  }
  return { kind: 'set', change };
}
