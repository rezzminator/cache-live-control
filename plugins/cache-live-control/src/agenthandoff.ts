// The agent handoff (option handoff): when a sub-agent is spawned, a neutral
// instruction is added to its prompt to write a handoff file before its final
// answer, so a cold agent need not be resumed: a fresh one starts from the file.
// The agent's own id is known only after the spawn returns, so the file is
// named by the id of the Agent tool call that spawned it.

/** The handoff file for the agent a spawn call started. */
export function handoffFile(dir: string, spawnId: string): string {
  return `${dir.replace(/\/+$/, '')}/${spawnId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

/** What the sub-agent is asked, appended to its prompt. */
export function instruction(path: string): string {
  return (
    `Before your final answer, write a handoff to ${path} so a fresh agent can continue without your context: ` +
    'the state of the work, decisions made and alternatives rejected (with why), next steps, file:line anchors, and open questions. ' +
    'If you cannot write that file, skip this step and say so in one line.'
  );
}

export function withInstruction(prompt: string, path: string): string {
  return `${prompt}\n\n${instruction(path)}`;
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * The plugin's own data directory for handoffs when `handoffDir` is empty:
 * `<plugins>/data/<plugin>-<marketplace>/handoffs` for an installed plugin (read
 * from its cache root `<plugins>/cache/<marketplace>/<plugin>/<version>`),
 * `<config dir>/plugins/data/<plugin>-inline/handoffs` for one loaded from a
 * directory. Undefined when neither is known as an absolute path.
 */
export function defaultDir(input: { root: string; name: string; configDir?: string; home?: string }): string | undefined {
  const parts = input.root.split('/');
  const cache = parts.findIndex((part, i) => part === 'cache' && parts[i - 1] === 'plugins');
  if (cache > 0 && parts.length >= cache + 3) {
    return `${parts.slice(0, cache).join('/')}/data/${safe(parts[cache + 2]!)}-${safe(parts[cache + 1]!)}/handoffs`;
  }
  // A relative directory would be read against the agent's working directory by the agent and another by the plugin.
  const absolute = (dir: string | undefined): dir is string => dir !== undefined && dir.startsWith('/');
  const config = absolute(input.configDir) ? input.configDir : absolute(input.home) ? `${input.home}/.claude` : undefined;
  if (config === undefined) return undefined;
  return `${config.replace(/\/+$/, '')}/plugins/data/${safe(input.name)}-inline/handoffs`;
}

/** The status segment `/cache` shows. */
export function handoffStatus(input: { handoff: boolean; dir?: string }): string {
  if (!input.handoff) return 'handoff off';
  return input.dir === undefined ? 'handoff on, no directory: set handoffDir' : `handoff on (${input.dir})`;
}
