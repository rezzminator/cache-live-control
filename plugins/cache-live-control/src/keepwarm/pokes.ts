/** One thread's poke count for one wait: `key` is the sorted set of its pending item ids. */
export interface PokeCount { key: string; count: number }
export function pokeKey(ids: readonly string[]): string { return [...new Set(ids)].sort().join('\n'); }
/** The count a wait stands at: the thread's counter while its key holds; a changed id set, or a counter real activity cleared (`null`), is a fresh key at zero. */
export function pokesFor(counter: PokeCount | null, key: string): PokeCount { return counter?.key === key ? counter : { key, count: 0 }; }
/** The counter after one more poke sent for this wait. A poke and its own reply are never activity, so they never clear it. */
export function pokeSent(counter: PokeCount | null, key: string): PokeCount { return { key, count: pokesFor(counter, key).count + 1 }; }
