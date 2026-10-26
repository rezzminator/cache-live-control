/**
 * True when a registration was refused only because this process has no bound
 * session: a headless run with no REPL mounted and no session built. The host
 * words it "... is not available in this mode: no session is bound ...".
 */
export function isUnboundMode(text: string): boolean {
  return text.includes('is not available in this mode') && text.includes('no session is bound');
}
