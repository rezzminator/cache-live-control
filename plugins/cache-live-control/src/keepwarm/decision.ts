import type { Ttl } from './ttl';
export type ReasonCode = 'agent-not-waiting' | 'eligible' | 'off' | 'busy' | 'stale' | 'in-flight' | 'inventory-unknown' | 'nothing-pending' | 'ended' | 'usage-unknown' | 'usage-invalid' | 'small' | '1h-unproven' | 'cache-cold' | 'expiry-safety' | 'wake-unknown' | 'cannot-wake' | 'poke-limit' | 'imminent' | 'budget' | 'marginal' | 'poke-failed' | 'timer-failed' | 'resumed' | 'idle';
export interface DecisionItem { id: string; expectedBackAt: number | null; wake: 'yes' | 'no' | 'unknown' }
export interface DecisionInput { agentStatus?: string; fault?: 'poke-failed' | 'timer-failed'; enabled: boolean; busy: boolean; currentEpoch: boolean; inFlight: boolean; known: boolean; context: number | null; minContext: number; lastSendAt: number | null; now: number; ttl: Ttl; warm1h: boolean; items: readonly DecisionItem[]; endedId?: string; pokes: { count: number; max: number }; spent: number; forecast: number; saved: number }
export interface Decision { action: 'warm' | 'skip' | 'stop'; reason: ReasonCode; items: string[]; itemId?: string }
export function decideWarm(input: DecisionInput): Decision {
  const stop = (reason: ReasonCode, action: Decision['action'] = 'stop', itemId?: string): Decision => ({ action, reason, items: [], ...(itemId ? { itemId } : {}) });
  if (!input.currentEpoch) return stop('stale');
  if (!input.enabled) return stop('off');
  if (input.agentStatus !== undefined && input.agentStatus !== 'waiting') return stop('agent-not-waiting');
  if (input.busy) return stop('busy');
  if (input.fault) return stop(input.fault);
  if (input.inFlight) return stop('in-flight', 'skip');
  if (!input.known) return stop('inventory-unknown');
  if (!input.items.length) return stop(input.endedId ? 'ended' : 'nothing-pending', 'stop', input.endedId);
  if (input.context === null || input.lastSendAt === null) return stop('usage-unknown');
  if (![input.context, input.lastSendAt, input.now, input.spent, input.forecast, input.saved, input.minContext].every(n => Number.isFinite(n) && n >= 0) || input.now < input.lastSendAt || !Number.isSafeInteger(input.pokes.count) || input.pokes.count < 0 || !Number.isSafeInteger(input.pokes.max) || input.pokes.max < 1) return stop('usage-invalid');
  if (input.pokes.count >= input.pokes.max) return stop('poke-limit');
  if (input.context < input.minContext) return stop('small');
  if (input.ttl === '1h' && !input.warm1h) return stop('1h-unproven');
  const expiry = input.lastSendAt + (input.ttl === '5m' ? 300000 : 3600000);
  if (input.now >= expiry) return stop('cache-cold');
  if (input.now >= expiry - 15000) return stop('expiry-safety');
  const waking = input.items.filter(item => item.wake === 'yes');
  if (!waking.length) return stop(input.items.some(item => item.wake === 'unknown') ? 'wake-unknown' : 'cannot-wake');
  const needed = waking.filter(item => item.expectedBackAt === null || item.expectedBackAt > expiry);
  if (!needed.length) return stop('imminent', 'skip');
  if (input.spent + input.forecast > input.saved) return stop('budget');
  if (input.saved - input.spent - input.forecast + 1e-9 < input.forecast * 0.1) return stop('marginal');
  return { action: 'warm', reason: 'eligible', items: needed.map(item => item.id) };
}
