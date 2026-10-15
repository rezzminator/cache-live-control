import { describe, expect, it } from 'vitest';
import { ENV, resolveOptions } from '../plugins/cache-live-control/src/options.ts';

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
    expect(resolveOptions({ mainTtl: '5m', ttlNotice: 'yes' })).toEqual({ main: '5m', errors: ['option ttlNotice "yes" ignored: use true, false, 1 or 0'] });
    expect(resolveOptions({ ttlNotice: 1 })).toEqual({ errors: ['option ttlNotice 1 ignored: use true, false, 1 or 0'] });
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
    for (const raw of ['x', '-5', '1.5k5', true, '9999999999999999999k', `${'9'.repeat(310)}k`, '9'.repeat(310)]) {
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

  it('takes summaries as block or allow; empty leaves Claude Code\'s behaviour', () => {
    expect(resolveOptions({ summaries: 'block' })).toEqual({ summaries: 'block', errors: [] });
    expect(resolveOptions({ summaries: ' BLOCK ' })).toEqual({ summaries: 'block', errors: [] });
    expect(resolveOptions({ summaries: 'allow' })).toEqual({ errors: [] });
    expect(resolveOptions({ summaries: '' })).toEqual({ errors: [] });
    expect(resolveOptions({ summaries: true })).toEqual({ errors: ['option summaries true ignored: use block, allow or empty'] });
    expect(resolveOptions({ summaries: 'off' })).toEqual({ errors: ['option summaries "off" ignored: use block, allow or empty'] });
  });
});

describe('the option variables', () => {
  const NOTICE = 'CACHE_LIVE_CONTROL_TTL_NOTICE';
  const RAISE = 'CACHE_LIVE_CONTROL_RAISE_AFTER_EXPIRIES';
  const GUARD = 'CACHE_LIVE_CONTROL_RESUME_GUARD';
  const FLOOR = 'CACHE_LIVE_CONTROL_RESUME_GUARD_MIN_TOKENS';
  const PRICE = 'CACHE_LIVE_CONTROL_RESUME_GUARD_PRICE';
  const SUMMARIES = 'CACHE_LIVE_CONTROL_SUMMARIES';

  it('names one variable per option', () => {
    expect(ENV).toEqual({
      mainTtl: 'CACHE_LIVE_CONTROL_MAIN_TTL',
      subagentTtl: 'CACHE_LIVE_CONTROL_SUBAGENT_TTL',
      ttlNotice: NOTICE,
      raiseAfterExpiries: RAISE,
      resumeGuard: GUARD,
      resumeGuardMinTokens: FLOOR,
      resumeGuardPrice: PRICE,
      summaries: SUMMARIES,
    });
  });

  // [case, option, env, resolved]: the variable beats the option, which beats the default;
  // a blank variable is absent; a bad one is named by its variable and leaves the default,
  // the option does not stand in for it.
  it.each([
    ['ttlNotice: 1 beats false', { ttlNotice: false }, { [NOTICE]: '1' }, { notice: true, errors: [] }],
    ['ttlNotice: TRUE beats the option, trimmed', {}, { [NOTICE]: ' TRUE ' }, { notice: true, errors: [] }],
    ['ttlNotice: 0 beats true', { ttlNotice: true }, { [NOTICE]: '0' }, { errors: [] }],
    ['ttlNotice: false beats true', { ttlNotice: 'true' }, { [NOTICE]: 'False' }, { errors: [] }],
    ['ttlNotice: unset takes the option', { ttlNotice: true }, {}, { notice: true, errors: [] }],
    ['ttlNotice: blank takes the option', { ttlNotice: true }, { [NOTICE]: '   ' }, { notice: true, errors: [] }],
    ['ttlNotice: bad is named, the default (off) stands over the option', { ttlNotice: true }, { [NOTICE]: 'yes' }, { errors: [`${NOTICE} "yes" ignored: use true, false, 1 or 0`] }],
    ['raiseAfterExpiries: the variable beats the option', { raiseAfterExpiries: '5' }, { [RAISE]: ' 2 ' }, { raiseAfter: 2, errors: [] }],
    ['raiseAfterExpiries: unset takes the option', { raiseAfterExpiries: '5' }, {}, { raiseAfter: 5, errors: [] }],
    ['raiseAfterExpiries: bad is named, off stands over the option', { raiseAfterExpiries: '5' }, { [RAISE]: '0' }, { errors: [`${RAISE} "0" ignored: use a whole number of 1 or more, or empty`] }],
    ['resumeGuard: the variable beats the option', { resumeGuard: 'warn' }, { [GUARD]: 'BLOCK' }, { guard: 'block', errors: [] }],
    ['resumeGuard: off beats the option', { resumeGuard: 'block' }, { [GUARD]: 'off' }, { errors: [] }],
    ['resumeGuard: bad is named, off stands over the option', { resumeGuard: 'block' }, { [GUARD]: 'maybe' }, { errors: [`${GUARD} "maybe" ignored: use off, warn or block`] }],
    ['resumeGuardMinTokens: the variable beats the option', { resumeGuardMinTokens: '1k' }, { [FLOOR]: '80k' }, { guardFloor: 80_000, errors: [] }],
    ['resumeGuardMinTokens: 0 beats the option', { resumeGuardMinTokens: '1k' }, { [FLOOR]: '0' }, { guardFloor: 0, errors: [] }],
    ['resumeGuardMinTokens: a k value past the safe integers is named, not accepted', {}, { [FLOOR]: '9999999999999999999k' }, { errors: [`${FLOOR} "9999999999999999999k" ignored: use a number of tokens such as 60000 or 60k, or empty`] }],
    ['mainTtl and subagentTtl: a set variable decides, so the option is not judged', { mainTtl: '2h', subagentTtl: 'x' }, { CACHE_LIVE_CONTROL_MAIN_TTL: '1h', CACHE_LIVE_CONTROL_SUBAGENT_TTL: ' auto ' }, { errors: [] }],
    ['mainTtl and subagentTtl: a blank variable leaves the option to be judged', { mainTtl: '2h' }, { CACHE_LIVE_CONTROL_MAIN_TTL: '  ' }, { errors: ['option mainTtl "2h" ignored: use 5m, 1h or empty'] }],
    ['resumeGuardMinTokens: bad is named, the default floor stands over the option', { resumeGuardMinTokens: '1k' }, { [FLOOR]: 'x' }, { errors: [`${FLOOR} "x" ignored: use a number of tokens such as 60000 or 60k, or empty`] }],
    ['resumeGuardPrice: the variable beats the option', { resumeGuardPrice: '3' }, { [PRICE]: '15' }, { guardPrice: 15, errors: [] }],
    ['resumeGuardPrice: bad is named, no price stands over the option', { resumeGuardPrice: '3' }, { [PRICE]: '-1' }, { errors: [`${PRICE} "-1" ignored: use a number (USD per million input tokens), or empty`] }],
    ['summaries: the variable beats the option', { summaries: 'allow' }, { [SUMMARIES]: 'Block' }, { summaries: 'block', errors: [] }],
    ['summaries: allow beats block', { summaries: 'block' }, { [SUMMARIES]: 'allow' }, { errors: [] }],
    ['summaries: bad is named, allow stands over the option', { summaries: 'block' }, { [SUMMARIES]: 'off' }, { errors: [`${SUMMARIES} "off" ignored: use block, allow or empty`] }],
  ] as const)('%s', (_name, options, env, resolved) => {
    expect(resolveOptions(options, env)).toEqual(resolved);
  });

  it('with no variable set, resolves exactly the options', () => {
    const options = { mainTtl: '5m', ttlNotice: true, raiseAfterExpiries: '3', resumeGuard: 'warn', resumeGuardMinTokens: '50k', resumeGuardPrice: '3', summaries: 'block' };
    expect(resolveOptions(options, {})).toEqual(resolveOptions(options));
    expect(resolveOptions(options, { [NOTICE]: undefined, [RAISE]: '' })).toEqual(resolveOptions(options));
  });
});
