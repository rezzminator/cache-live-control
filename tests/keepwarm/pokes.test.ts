import { expect, test } from 'vitest';
import { pokeKey, pokesFor, pokeSent } from '../../plugins/cache-live-control/src/keepwarm/pokes.ts';
function call<T>(fn: () => T): T | string { try { return fn(); } catch (error) { return String(error); } }
test('a wait is keyed by its sorted set of pending ids, order and duplicates aside', () => {
  expect(call(() => pokeKey(['b', 'a', 'b']))).toBe(call(() => pokeKey(['a', 'b'])));
  expect(call(() => pokeKey(['a']))).not.toBe(call(() => pokeKey(['a', 'b'])));
});
test('the cap counts sends on one unchanged key and stops at N', () => {
  const key = pokeKey(['a']), max = 4;
  let counter = null as ReturnType<typeof pokeSent> | null, sent = 0;
  for (let i = 0; i < 10; i++) { if (pokesFor(counter, key).count >= max) break; counter = pokeSent(counter, key); sent++; }
  expect(sent).toBe(4); expect(counter).toEqual({ key, count: 4 });
});
test('a changed id set after a reached limit starts a fresh key at zero', () => {
  const reached = { key: pokeKey(['a']), count: 4 };
  expect(call(() => pokesFor(reached, pokeKey(['a'])))).toEqual(reached);
  expect(call(() => pokesFor(reached, pokeKey(['a', 'b'])))).toEqual({ key: pokeKey(['a', 'b']), count: 0 });
  expect(call(() => pokesFor(reached, pokeKey([])))).toEqual({ key: pokeKey([]), count: 0 });
  expect(call(() => pokeSent(reached, pokeKey(['b'])))).toEqual({ key: pokeKey(['b']), count: 1 });
});
test('activity clears the counter, so the same key counts again from zero', () => {
  expect(call(() => pokesFor(null, pokeKey(['a'])))).toEqual({ key: pokeKey(['a']), count: 0 });
  expect(call(() => pokeSent(null, pokeKey(['a'])))).toEqual({ key: pokeKey(['a']), count: 1 });
});
