import { expect, test } from 'vitest';
import { isUnboundMode } from '../plugins/cache-live-control/src/mode.ts';

const unbound = 'cache-live-control: $.command.register is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on';

test.each([
  { text: unbound, expected: true },
  { text: '$.command.register is not available in this mode: no session is bound', expected: true },
  { text: 'register refused', expected: false },
  { text: '$.command.register is not available in this mode: the command is already taken', expected: false },
  { text: 'no session is bound', expected: false },
  { text: '', expected: false },
])('isUnboundMode($text) is $expected', ({ text, expected }) => {
  expect(isUnboundMode(text)).toBe(expected);
});
