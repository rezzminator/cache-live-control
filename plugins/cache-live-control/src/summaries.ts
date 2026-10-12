// The sub-agent progress summaries (option summaries, `/cache summaries off|on`).
// While a sub-agent runs, Claude Code sends the agent's whole conversation to
// its model again every ~30 s to get a 3-5 word status line for the agent
// panel. No hook sees that request, so the plugin marks every request with a
// header, through ANTHROPIC_CUSTOM_HEADERS (which Claude Code re-reads for each
// request), and a gateway on ANTHROPIC_BASE_URL that honours the mark answers
// the summary request itself. Without such a gateway the mark changes nothing.

/** The header a gateway reads; its value `block` asks it to answer the summary request itself. */
export const SUMMARY_HEADER = 'x-cache-live-control-summaries';

const BLOCK = 'block';

function nameOf(line: string): string {
  const colon = line.indexOf(':');
  return (colon < 0 ? line : line.slice(0, colon)).trim().toLowerCase();
}

function valueOf(line: string): string {
  const colon = line.indexOf(':');
  return colon < 0 ? '' : line.slice(colon + 1).trim().toLowerCase();
}

function linesOf(current: string | undefined): string[] {
  return (current ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
}

/**
 * ANTHROPIC_CUSTOM_HEADERS with the mark present once (`blocked`) or absent: the
 * user's own lines stay as they are, a line of the mark's name is replaced.
 * Undefined when no line is left, so the variable is unset. Not blocked and
 * holding no line of the mark's name, the value comes back byte for byte.
 */
export function withMark(current: string | undefined, blocked: boolean): string | undefined {
  const lines = linesOf(current);
  if (!blocked && !lines.some((line) => nameOf(line) === SUMMARY_HEADER)) return current;
  const kept = lines.filter((line) => nameOf(line) !== SUMMARY_HEADER);
  const next = blocked ? [...kept, `${SUMMARY_HEADER}: ${BLOCK}`] : kept;
  return next.length === 0 ? undefined : next.join('\n');
}

/** Whether ANTHROPIC_CUSTOM_HEADERS holds the mark with the value `block`. */
export function isMarked(current: string | undefined): boolean {
  return linesOf(current).some((line) => nameOf(line) === SUMMARY_HEADER && valueOf(line) === BLOCK);
}

/** The status segment `/cache` shows, from what the variable holds. */
export function summariesStatus(marked: boolean): string {
  return marked ? `summaries off (sends ${SUMMARY_HEADER}: ${BLOCK}; a gateway must answer them)` : 'summaries on';
}
