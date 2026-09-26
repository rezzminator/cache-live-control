// The TTL values Claude Code accepts from its cache-TTL variables, and the
// two parties that read them: the main chat and every sub-agent (with
// workflows and background helper requests).

export type Ttl = '5m' | '1h';

export type Party = 'main' | 'agents';

export const PARTIES: readonly Party[] = ['main', 'agents'];

/** The variable each party's TTL is read from, per request. */
export const VARIABLE: Readonly<Record<Party, string>> = {
  main: 'CLAUDE_CODE_PROMPT_CACHE_TTL',
  agents: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
};

export function isTtl(value: unknown): value is Ttl {
  return value === '5m' || value === '1h';
}

/**
 * A change per party: a TTL to set, `null` to unset (hand back to settings,
 * agent frontmatter and the automatic choice), absent to leave it alone.
 */
export type Change = Partial<Record<Party, Ttl | null>>;
