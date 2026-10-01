import type { EnvSnapshot } from './status.ts';

// ENABLE_PROMPT_CACHING_1H turns 1h on for the main chat AND every sub-agent
// (Claude Code: sub-agents are "5 minutes unless ENABLE_PROMPT_CACHING_1H=1").
// The plugin keeps the launch's 1h for the main chat only, so a sub-agent
// defaults to 5m and only subagentPromptCacheTtl, its own frontmatter or
// /cache raises it.

export const ENABLE_1H = 'ENABLE_PROMPT_CACHING_1H';

/** Claude Code's reading of a boolean variable: 1, true, yes or on. */
export function isEnvTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

export type LaunchChange = {
  /** Set the main chat's variable to the launch's 1h; absent when it is already set. */
  main?: '1h';
  /** Unset ENABLE_PROMPT_CACHING_1H, so it stops reaching the sub-agents. */
  unsetEnable1h: boolean;
};

/** `mainChosen`: a launcher's handoff already chose the main chat's TTL (`auto` included). */
export function launchChange(env: EnvSnapshot, mainChosen = false): LaunchChange {
  if (!isEnvTruthy(env.enable1h)) return { unsetEnable1h: false };
  return (env.main ?? '') === '' && !mainChosen ? { main: '1h', unsetEnable1h: true } : { unsetEnable1h: true };
}
