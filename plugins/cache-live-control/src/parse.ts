import type { Change, Ttl } from './ttl.ts';

// `/cache` arguments to the one thing the command does.

export type Action =
  | { kind: 'status' }
  | { kind: 'set'; change: Change }
  | { kind: 'error'; message: string };

export const USAGE = 'usage: /cache [5m|1h|auto] | /cache main 5m|1h|auto | /cache agents 5m|1h|auto';

/** A TTL word: the TTL, `null` for `auto`, undefined for anything else. */
function ttlWord(word: string | undefined): Ttl | null | undefined {
  if (word === '5m' || word === '1h') return word;
  if (word === 'auto') return null;
  return undefined;
}

export function parseArgs(args: string): Action {
  const words = args.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return { kind: 'status' };
  if (words.length === 1) {
    const value = ttlWord(words[0]);
    if (value !== undefined) return { kind: 'set', change: { main: value, agents: value } };
  }
  if (words.length === 2) {
    const value = ttlWord(words[1]);
    if (value !== undefined && words[0] === 'main') return { kind: 'set', change: { main: value } };
    if (value !== undefined && words[0] === 'agents') return { kind: 'set', change: { agents: value } };
  }
  return { kind: 'error', message: `nothing changed, "${args.trim()}" is not understood; ${USAGE}` };
}
