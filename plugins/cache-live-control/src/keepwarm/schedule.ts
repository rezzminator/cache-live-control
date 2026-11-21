import type { Ttl } from './ttl.ts';
export const WARM_1H = true;
export const SAFETY_MS = 15_000;
export const TTL_MS = { '5m': 300_000, '1h': 3_600_000 } as const;
export function nextFireAt({ lastSendAt, ttl }: { lastSendAt: number; ttl: Ttl }): number { return lastSendAt + TTL_MS[ttl] * 0.8; }
export function isLate({ lastSendAt, ttl, now }: { lastSendAt: number; ttl: Ttl; now: number }): boolean { return now >= lastSendAt + TTL_MS[ttl]; }
