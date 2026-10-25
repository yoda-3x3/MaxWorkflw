import type { Agent, AgentStatus, AgentRole } from '../../lib/types';

export const ROLE_LABEL: Record<AgentRole, string> = {
  orchestrator: 'Orchestrator',
  lead: 'Lead',
  worker: 'Worker',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Waiting for approval',
  done: 'Done',
  failed: 'Failed',
};

export function isActive(status: AgentStatus): boolean {
  return status === 'running' || status === 'waiting_approval';
}

// Elapsed time for an agent. Agents that never started have none; finished
// agents stop at endedAt; running agents tick against `now`.
export function elapsedMs(agent: Agent, now: number): number | null {
  if (agent.startedAt === undefined) return null;
  const end = agent.endedAt ?? now;
  return Math.max(0, end - agent.startedAt);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// First non-empty line of a report, clipped for a card snippet.
export function reportSnippet(report: string | undefined, max = 160): string {
  if (!report) return '';
  const line = report
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// Display order: tier first, then start time, then id.
export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const sa = a.startedAt ?? a.createdAt;
    const sb = b.startedAt ?? b.createdAt;
    if (sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });
}
