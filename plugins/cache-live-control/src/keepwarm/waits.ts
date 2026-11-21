import type { AgentInfo, ClassicHookInputs } from 'claude-code';
export type TaskSummary = NonNullable<ClassicHookInputs['Stop']['background_tasks']>[number];
export interface WaitItem { id: string; kind: string; label: string }
export interface EndedItem { item: WaitItem; ended: 'completed' | 'failed' | 'killed' }
export interface WaitSnapshot { known: boolean; items: WaitItem[]; ended?: EndedItem[] }
export function sanitizeLabel(text: string): string {
  const clean = text.replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : clean;
}
export function fromStop(tasks: readonly TaskSummary[] | undefined, _now: number): WaitSnapshot {
  if (!Array.isArray(tasks)) return { known: false, items: [] };
  const items: WaitItem[] = [], ended: EndedItem[] = [];
  for (const task of tasks) {
    const kind = task.type === 'subagent' ? 'agent' : task.type === 'shell' ? 'command' : task.type;
    const item = { id: task.id, kind, label: sanitizeLabel(task.type === 'shell' ? task.command || task.description : task.description) };
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'killed') ended.push({ item, ended: task.status });
    else if (!items.some(other => other.id === item.id)) items.push(item);
  }
  return { known: true, items, ...(ended.length ? { ended } : {}) };
}
export function reconcile(items: readonly WaitItem[], agents: readonly Pick<AgentInfo, 'id' | 'status'>[], pendingOnly = false): { items: WaitItem[]; ended: EndedItem[] } {
  const kept: WaitItem[] = [], ended: EndedItem[] = [];
  const statuses = new Map(agents.map(agent => [agent.id, agent.status]));
  for (const item of items) {
    const status = item.kind === 'agent' ? statuses.get(item.id) : undefined;
    if (status === 'completed' || status === 'failed' || status === 'killed') ended.push({ item, ended: status });
    else if (!pendingOnly || item.kind !== 'agent' || status === 'pending' || status === 'running' || status === 'waiting') kept.push(item);
  }
  return { items: kept, ended };
}
export function firstSeen(items: readonly WaitItem[], previous: ReadonlyMap<string, number>, now: number): Map<string, number> {
  return new Map(items.map(item => [item.id, Math.min(previous.get(item.id) ?? now, now)]));
}

export function ownedFromTool(tool: string, input: Record<string, unknown>, result: unknown): WaitItem | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.error || r.status === 'completed' || r.backgroundEndsWithFinalResponse) return null;
  let id: unknown, kind: string, label: unknown;
  if (tool === 'Bash') { id = r.backgroundTaskId; kind = 'command'; label = input.command; }
  else if (tool === 'Agent') { id = r.agentId ?? r.agent_id ?? r.taskId; kind = 'agent'; label = input.description ?? r.description; }
  else if (tool === 'Skill' && r.background === true) { id = r.agentId; kind = 'agent'; label = r.commandName; }
  else if (tool === 'Monitor') { id = r.taskId; kind = 'monitor'; label = 'Monitor'; }
  else if (tool === 'Workflow') { id = r.taskId; kind = 'workflow'; label = r.workflowName ?? 'Workflow'; }
  else return null;
  return typeof id === 'string' && id.length > 0 ? { id, kind, label: sanitizeLabel(typeof label === 'string' ? label : 'your background work') } : null;
}

/** Whether the last user message is this plugin's own poke, raw or as Claude Code wraps a coordinator send; tools may follow it. */
export function warmReceipt(messages: readonly { role: string; text: string; toolUses: readonly unknown[] }[], expected: string): { own: boolean } {
  const index = messages.findLastIndex(m => m.role === 'user');
  if (index < 0) return { own: false };
  const text = messages[index]!.text;
  const wrapped = `The coordinator sent a message while you were working:\n${expected}\n\nAddress this before completing your current task.`;
  return { own: text === expected || text === wrapped };
}
