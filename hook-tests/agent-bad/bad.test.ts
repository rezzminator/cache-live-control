import { describe, expect, test } from 'claude-code/testing';
import { cache, START, world } from '../world.ts';

// Run by scripts/test-hook-variants.sh with bad manifest defaults for the
// string options of the sub-agent cache protection.

describe('bad options', () => {
  test('are ignored by name, leave every piece off, and are shown by /cache', async ($, on) => {
    world(on);
    await $.session.start(START);
    const text = await cache($);
    expect(text).toContain(' · auto-raise off · resume-guard off · handoff off · ');
    for (const error of [
      'option resumeGuard "maybe" ignored: use off, warn or block',
      'option resumeGuardMinTokens "lots" ignored: use a number of tokens such as 60000 or 60k, or empty',
      'option resumeGuardPrice "-1" ignored: use a number (USD per million input tokens), or empty',
    ]) {
      expect(text).toContain(error);
    }
  });
});
