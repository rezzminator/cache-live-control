import type { Register } from 'claude-code';
import { cacheState, cacheSessionStart, cacheTurnStart, cacheTurnStep, cacheTurnComplete, cachePromptSubmit, cacheSessionCompact, cacheSessionEnd, registerCache } from './cache-live-control.ts';
import { keepwarmState, keepwarmSessionStart, keepwarmTurnStart, keepwarmTurnStep, keepwarmTurnComplete, keepwarmPromptSubmit, keepwarmSessionCompact, keepwarmSessionEnd, registerKeepwarm } from './keepwarm.ts';

// Claude Code loads one hooks module per plugin (hooks.json `modules` holds at most one path) and refuses
// the same event registered twice under one matcher, so this file is that module. The seven events both
// features hook are registered once each, the TTL control outermost and keep-warm inside it, as two modules
// would chain; every other hook is registered by its own adapter (registerCache, registerKeepwarm).
export const register: Register = (on, options) => {
  const cache = cacheState(options), keep = keepwarmState(options);
  registerCache(on, cache);
  registerKeepwarm(on, keep);
  on('session.start', ($, e, next) => cacheSessionStart($, e, Object.assign((passed: typeof e) => keepwarmSessionStart($, passed, next, keep), next), cache));
  on('prompt.submit', ($, e, next) => cachePromptSubmit($, e, Object.assign((passed: typeof e) => keepwarmPromptSubmit($, passed, next, keep), next), cache));
  on('turn.start', ($, e, next) => cacheTurnStart($, e, Object.assign((passed: typeof e) => keepwarmTurnStart($, passed, next, keep), next), cache));
  on('turn.complete', ($, e, next) => cacheTurnComplete($, e, Object.assign((passed: typeof e) => keepwarmTurnComplete($, passed, next, keep), next), cache));
  on('session.compact', ($, e, next) => cacheSessionCompact($, e, Object.assign((passed: typeof e) => keepwarmSessionCompact($, passed, next, keep), next), cache));
  on('session.end', ($, e, next) => cacheSessionEnd($, e, Object.assign((passed: typeof e) => keepwarmSessionEnd($, passed, next, keep), next), cache));
  on('turn.step', async function* ($, e, next) { return yield* cacheTurnStep($, e, Object.assign((passed: typeof e) => keepwarmTurnStep($, passed, next, keep), next), cache); });
};
