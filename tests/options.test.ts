import { describe, expect, it } from 'vitest';
import { resolveOptions } from '../plugins/cache-live-control/src/options.ts';

describe('resolveOptions', () => {
  it('takes 5m and 1h for each party', () => {
    expect(resolveOptions({ mainTtl: '5m', subagentTtl: '1h' })).toEqual({ main: '5m', agents: '1h', errors: [] });
  });

  it('leaves a party automatic when its option is empty or missing', () => {
    expect(resolveOptions({ mainTtl: '', subagentTtl: '' })).toEqual({ errors: [] });
    expect(resolveOptions({})).toEqual({ errors: [] });
  });

  it('trims and lowercases', () => {
    expect(resolveOptions({ mainTtl: ' 1H ' })).toEqual({ main: '1h', errors: [] });
  });

  it('ignores a bad value, naming the option and the value', () => {
    expect(resolveOptions({ mainTtl: '2h', subagentTtl: 'auto' })).toEqual({
      errors: ['option mainTtl "2h" ignored: use 5m, 1h or empty', 'option subagentTtl "auto" ignored: use 5m, 1h or empty'],
    });
  });

  it('ignores a value that is not a string', () => {
    expect(resolveOptions({ mainTtl: 5, subagentTtl: true })).toEqual({
      errors: ['option mainTtl 5 ignored: use 5m, 1h or empty', 'option subagentTtl true ignored: use 5m, 1h or empty'],
    });
  });

  it('keeps a good option beside a bad one', () => {
    expect(resolveOptions({ mainTtl: '5m', subagentTtl: 'x' })).toEqual({ main: '5m', errors: ['option subagentTtl "x" ignored: use 5m, 1h or empty'] });
  });

  it('turns the TTL notice on for true, as a boolean or a string', () => {
    expect(resolveOptions({ ttlNotice: true })).toEqual({ notice: true, errors: [] });
    expect(resolveOptions({ ttlNotice: 'true' })).toEqual({ notice: true, errors: [] });
    expect(resolveOptions({ ttlNotice: ' TRUE ' })).toEqual({ notice: true, errors: [] });
  });

  it('leaves the TTL notice off for false, empty or missing', () => {
    for (const ttlNotice of [false, 'false', 'False', '', undefined]) expect(resolveOptions({ ttlNotice })).toEqual({ errors: [] });
  });

  it('ignores any other ttlNotice, naming it and its value', () => {
    expect(resolveOptions({ mainTtl: '5m', ttlNotice: 'yes' })).toEqual({ main: '5m', errors: ['option ttlNotice "yes" ignored: use true or false'] });
    expect(resolveOptions({ ttlNotice: 1 })).toEqual({ errors: ['option ttlNotice 1 ignored: use true or false'] });
  });

  it('takes raiseAfterExpiries as a whole number of 1 or more, as a string or a number', () => {
    expect(resolveOptions({ raiseAfterExpiries: '2' })).toEqual({ raiseAfter: 2, errors: [] });
    expect(resolveOptions({ raiseAfterExpiries: ' 12 ' })).toEqual({ raiseAfter: 12, errors: [] });
    expect(resolveOptions({ raiseAfterExpiries: '02' })).toEqual({ raiseAfter: 2, errors: [] });
    expect(resolveOptions({ raiseAfterExpiries: 3 })).toEqual({ raiseAfter: 3, errors: [] });
  });

  it('leaves the auto-raise off when raiseAfterExpiries is empty or missing', () => {
    for (const raiseAfterExpiries of ['', '  ', undefined]) expect(resolveOptions({ raiseAfterExpiries })).toEqual({ errors: [] });
  });

  it('ignores any other raiseAfterExpiries, naming it and its value', () => {
    const use = 'use a whole number of 1 or more, or empty';
    for (const raw of ['0', '-1', '2.5', 'two', '1e3', '99999999999999999999', 0, 1.5, true]) {
      expect(resolveOptions({ raiseAfterExpiries: raw })).toEqual({ errors: [`option raiseAfterExpiries ${JSON.stringify(raw)} ignored: ${use}`] });
    }
  });

  it('keeps a good raiseAfterExpiries beside a bad TTL option', () => {
    expect(resolveOptions({ mainTtl: '5m', subagentTtl: 'x', raiseAfterExpiries: '2' })).toEqual({
      main: '5m',
      raiseAfter: 2,
      errors: ['option subagentTtl "x" ignored: use 5m, 1h or empty'],
    });
  });
});

describe('the sub-agent cache protection options', () => {
  it('takes resumeGuard as warn or block, in any case; off and empty leave it off', () => {
    expect(resolveOptions({ resumeGuard: 'block' })).toEqual({ guard: 'block', errors: [] });
    expect(resolveOptions({ resumeGuard: ' WARN ' })).toEqual({ guard: 'warn', errors: [] });
    for (const resumeGuard of ['off', '', undefined]) expect(resolveOptions({ resumeGuard })).toEqual({ errors: [] });
    expect(resolveOptions({ resumeGuard: 'maybe' })).toEqual({ errors: ['option resumeGuard "maybe" ignored: use off, warn or block'] });
  });

  it('takes resumeGuardMinTokens as tokens or Nk, zero included', () => {
    expect(resolveOptions({ resumeGuardMinTokens: '80000' })).toEqual({ guardFloor: 80_000, errors: [] });
    expect(resolveOptions({ resumeGuardMinTokens: '80k' })).toEqual({ guardFloor: 80_000, errors: [] });
    expect(resolveOptions({ resumeGuardMinTokens: 0 })).toEqual({ guardFloor: 0, errors: [] });
    expect(resolveOptions({ resumeGuardMinTokens: '' })).toEqual({ errors: [] });
    const use = 'use a number of tokens such as 60000 or 60k, or empty';
    for (const raw of ['x', '-5', '1.5k5', true]) {
      expect(resolveOptions({ resumeGuardMinTokens: raw })).toEqual({ errors: [`option resumeGuardMinTokens ${JSON.stringify(raw)} ignored: ${use}`] });
    }
  });

  it('takes resumeGuardPrice as a positive number', () => {
    expect(resolveOptions({ resumeGuardPrice: '3' })).toEqual({ guardPrice: 3, errors: [] });
    expect(resolveOptions({ resumeGuardPrice: 2.5 })).toEqual({ guardPrice: 2.5, errors: [] });
    expect(resolveOptions({ resumeGuardPrice: '' })).toEqual({ errors: [] });
    const use = 'use a number (USD per million input tokens), or empty';
    for (const raw of ['abc', '0', '-1']) expect(resolveOptions({ resumeGuardPrice: raw })).toEqual({ errors: [`option resumeGuardPrice ${JSON.stringify(raw)} ignored: ${use}`] });
  });

  it('takes agentRaiseWaiting and handoff as true or false, as a boolean or its spelling', () => {
    expect(resolveOptions({ agentRaiseWaiting: true, handoff: 'true' })).toEqual({ agentRaiseWaiting: true, handoff: true, errors: [] });
    expect(resolveOptions({ agentRaiseWaiting: false, handoff: 'false' })).toEqual({ errors: [] });
    expect(resolveOptions({ agentRaiseWaiting: 'yes', handoff: 1 })).toEqual({
      errors: ['option agentRaiseWaiting "yes" ignored: use true or false', 'option handoff 1 ignored: use true or false'],
    });
  });

  it('takes agentRaiseAfterExpiries as a whole number of 1 or more', () => {
    expect(resolveOptions({ agentRaiseAfterExpiries: '3' })).toEqual({ agentRaiseAfter: 3, errors: [] });
    expect(resolveOptions({ agentRaiseAfterExpiries: '' })).toEqual({ errors: [] });
    expect(resolveOptions({ agentRaiseAfterExpiries: '0' })).toEqual({
      errors: ['option agentRaiseAfterExpiries "0" ignored: use a whole number of 1 or more, or empty'],
    });
  });

  it('takes handoffDir as a path; empty leaves the default', () => {
    expect(resolveOptions({ handoffDir: ' /tmp/handoffs ' })).toEqual({ handoffDir: '/tmp/handoffs', errors: [] });
    expect(resolveOptions({ handoffDir: '' })).toEqual({ errors: [] });
    expect(resolveOptions({ handoffDir: 5 })).toEqual({ errors: ['option handoffDir 5 ignored: use an absolute directory path, or empty'] });
    // A relative path would be read against the sub-agent's working directory, not the plugin's.
    expect(resolveOptions({ handoffDir: 'handoffs' })).toEqual({ errors: ['option handoffDir "handoffs" ignored: use an absolute directory path, or empty'] });
  });
});
