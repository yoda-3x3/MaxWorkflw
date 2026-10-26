import { MAX_AGENTS, RUN_DEADLINE_MS } from "../../lib/types";

/** "3m 05s", "2h 10m", "4d 3h". Negative or NaN input renders as "0s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Time left before a run's deadline, e.g. "5h 12m left" or "deadline passed". */
export function deadlineLabel(deadlineAt: number, now: number): string {
  const left = deadlineAt - now;
  return left <= 0 ? "deadline passed" : `${formatDuration(left)} left`;
}

/** Token count with a compact suffix: 950, 12.4k, 1.3M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Agent count against the cap, e.g. "4/15". */
export function agentCountLabel(count: number): string {
  return `${count}/${MAX_AGENTS}`;
}

/** Usage as a percent, 0..100. The SDK sends 0..1; some versions send 0..100. */
export function usagePercent(utilization: number | undefined): number {
  const u = utilization ?? 0;
  return Math.min(100, Math.max(0, u <= 1 ? u * 100 : u));
}

/** "five_hour" -> "5-hour", "seven_day" -> "7-day"; anything else just loses its underscores. */
export function usageLabel(type: string): string {
  const named: Record<string, string> = { five_hour: "5-hour", seven_day: "7-day", seven_day_opus: "7-day Opus", seven_day_sonnet: "7-day Sonnet" };
  return named[type] ?? type.replaceAll("_", " ");
}

/** "resets 10:00 PM · in 2h 39m" (resetsAt is unix seconds from the SDK; ms tolerated). */
export function usageResetLabel(resetsAt: number, now: number): string {
  const at = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const left = at - now;
  if (left <= 0) return "reset now";
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  const when = new Date(at).toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
  const h = Math.floor(left / 3_600_000);
  const m = Math.round((left % 3_600_000) / 60_000);
  return `resets ${when} · in ${h ? `${h}h ` : ""}${m}m`;
}

/** Share of the 24h deadline already used, clamped to [0, 1]. */
export function deadlineProgress(createdAt: number, deadlineAt: number, now: number): number {
  const total = deadlineAt - createdAt || RUN_DEADLINE_MS;
  return Math.min(1, Math.max(0, (now - createdAt) / total));
}

/** Short relative time for history rows: "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(then: number, now: number): string {
  const diff = Math.max(0, now - then);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** True while a run is queued and no agent has started yet: the PC runner is picking it up. */
export function isRunnerStarting(run: { status: string; agents: { status: string }[] }): boolean {
  return run.status === "queued" && run.agents.every((a) => a.status === "queued");
}

/** True for a draft: created, attachments may still be uploading, and not queued yet. */
export function isDraft(run: { status: string }): boolean {
  return run.status === "draft";
}

/** Human label for a run status: "draft", "waiting approval", "done". */
export function statusLabel(status: string): string {
  return status.replace("_", " ");
}

/** PR label for display, e.g. "owner/name#12". Null until both repo and PR number exist. */
export function prLabel(repo: string | undefined, prNumber: number | undefined): string | null {
  if (!repo || prNumber === undefined) return null;
  return `${repo}#${prNumber}`;
}
