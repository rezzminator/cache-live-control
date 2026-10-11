// The short log `/cache` shows beside the protection pieces: what the plugin
// raised, held, released, blocked or let through, newest last in memory and
// newest first on screen.

export type Event = { at: number; text: string };

/** Events kept in memory. */
export const EVENT_CAP = 8;

/** Events `/cache` prints. */
const SHOWN = 4;

const MIN = 60_000;

/** A duration: `under a minute`, minutes up to two hours, then whole hours. */
export function span(ms: number): string {
  if (ms < MIN) return 'under a minute';
  const minutes = Math.floor(ms / MIN);
  return minutes < 120 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

/** How long ago: `just now` under a minute. */
export function ago(ms: number): string {
  return ms < MIN ? 'just now' : `${span(ms)} ago`;
}

/** The events with `event` last, keeping the newest `cap`; the input is never changed. */
export function pushEvent(events: readonly Event[], event: Event, cap: number = EVENT_CAP): Event[] {
  return [...events, event].slice(-cap);
}

/** `recent: newest 1m ago; older 5m ago`, or absent when there are none. */
export function formatEvents(events: readonly Event[], now: number): string | undefined {
  if (events.length === 0) return undefined;
  const shown = events.slice(-SHOWN).reverse();
  return `recent: ${shown.map((e) => `${e.text} ${ago(Math.max(0, now - e.at))}`).join('; ')}`;
}
