import { expect, test } from 'vitest';
import { effectiveEnabled, parseControl } from '../../plugins/cache-live-control/src/keepwarm/control.ts';
function call<T>(fn: () => T): T | string { try { return fn(); } catch (error) { return String(error); } }
test.each([['', 'status'], [' status ', 'status'], ['on', 'on'], ['off', 'off'], ['ON', 'invalid'], ['on off', 'invalid']])('command %s', (args, expected) => expect(call(() => parseControl(args))).toBe(expected));
test.each([[true, null, true], [false, null, false], [false, true, true], [true, false, false]])('override %#', (launch, override, expected) => expect(call(() => effectiveEnabled(Boolean(launch), override === null ? null : Boolean(override)))).toBe(expected));
