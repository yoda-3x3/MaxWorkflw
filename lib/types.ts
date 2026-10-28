// Shared contract for WorkflwPro. Every unit (auth, store, engine, UI, ...) imports from here.
// Keep this file types-and-constants only; no I/O.

// ---- Limits (enforced in the engine, not just the prompt) ----

/** Max agents per run, counted across all tiers including the Orchestrator. */
export const MAX_AGENTS = 30;

/** Max tiers: Orchestrator (1) -> Lead (2) -> Worker (3). */
export const MAX_DEPTH = 3;

/** Every run must finish within this many ms of creation, or it fails with a clear message. */
export const RUN_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** An agent stuck in `running` longer than this is reset to `queued` by the engine. */
export const AGENT_STALL_MS = 5 * 60 * 1000;

/** Each agent gets this many attempts in total (one retry) before it is marked failed. */
export const AGENT_MAX_ATTEMPTS = 2;

/** Largest single attachment. */
export const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
/** Largest total of attachments on one run. */
export const MAX_RUN_UPLOAD_BYTES = 90 * 1024 * 1024;
/** Max attachments per run. */
export const MAX_FILES_PER_RUN = 20;
/** Every chunk except the last is exactly this many raw bytes. One chunk is one request. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;

// ---- Tiers, roles, models ----

/** 1 = Orchestrator, 2 = Lead, 3 = Worker. */
export type Tier = 1 | 2 | 3;

export type AgentRole = "orchestrator" | "lead" | "worker";

/** Model IDs. Defaults come from env (ORCHESTRATOR_MODEL, LEAD_MODEL, WORKER_MODEL). */
export type ModelId = string;

/** Models offered in Advanced options. Anything else is rejected by the route. */
export const MODEL_CHOICES = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
] as const;

// ---- Per-run options (Advanced options on the New run form) ----

/** Where the run executes. auto = the PC if its runner is online, otherwise the cloud. */
export type RunOn = "auto" | "pc" | "cloud";

/** Team shape the Orchestrator is asked for. three-tier = every unit is a Lead with Workers. */
export type TeamShape = "auto" | "three-tier" | "flat";

export interface RunOptions {
  runOn?: RunOn;
  shape?: TeamShape;
  /** Agent cap for this run, 2..MAX_AGENTS. */
  maxAgents?: number;
  /** Per-tier model overrides; unset tiers use the runner's defaults. */
  models?: Partial<Record<AgentRole, ModelId>>;
}

/** Which runner's queue a started run went to. */
export type Placement = "pc" | "cloud";

// ---- Statuses ----

export type RunStatus =
  | "draft" // created, attachments may still be uploading; not queued
  | "queued" // started, waiting for the runner, plan not started yet
  | "planning" // orchestrator is producing the plan
  | "running" // units/workers are executing
  | "waiting_approval" // nothing else can run; at least one approval is pending
  | "finalizing" // all units done; orchestrator writing the final report
  | "done"
  | "failed"; // includes deadline exceeded and unrecoverable errors

export type AgentStatus =
  | "queued"
  | "running"
  | "waiting_approval" // this agent alone is paused on an approval
  | "done"
  | "failed";

// ---- Plan (orchestrator output, JSON) ----

/** A worker inside a unit. Workers of one lead run in parallel. */
export interface PlanWorker {
  id: string;
  title: string;
  brief: string;
  deps?: string[];
}

/**
 * A unit of work. With `workers` it becomes a Lead (Sonnet) with Haiku workers;
 * without, it becomes a standalone Sonnet worker.
 */
export interface PlanUnit {
  id: string;
  title: string;
  brief: string;
  /** Ids of other units that must be done first. */
  deps: string[];
  workers?: PlanWorker[];
}

/** Orchestrator's plan: `{summary, units}` as JSON. */
export interface Plan {
  summary: string;
  units: PlanUnit[];
}

// ---- Agents ----

export interface Agent {
  id: string;
  runId: string;
  /** Null for the Orchestrator. */
  parentId: string | null;
  tier: Tier;
  role: AgentRole;
  title: string;
  model: ModelId;
  status: AgentStatus;
  /** Full brief sent to the agent (template from ORCHESTRATOR_PROMPT §4). */
  brief: string;
  /** Ids this agent waits on (within the run). */
  deps: string[];
  /** Full report. Upward-passed copies are clipped by the engine, not here. */
  report?: string;
  error?: string;
  /** Attempts so far; capped at AGENT_MAX_ATTEMPTS. */
  attempts: number;
  /** Input + output tokens used by this agent across attempts. */
  tokens: number;
  /** Set while the agent is paused on an approval. */
  approvalId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

// ---- Approvals (the four hard stops) ----

export type ApprovalKind =
  | "production_deploy"
  | "destructive_op" // delete files/data, force-push, migrations
  | "paid_or_secret" // new paid service, or create/touch secrets or credentials
  | "budget_exceeded"; // tokens, agents or the 24h deadline

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Approval {
  id: string;
  runId: string;
  agentId: string;
  kind: ApprovalKind;
  /** What the agent wants to do, in one or two sentences. */
  request: string;
  status: ApprovalStatus;
  /** Optional note from the owner; fed into the agent's brief on resume. */
  note?: string;
  createdAt: number;
  decidedAt?: number;
}

/**
 * Written by the UI when the owner clicks Approve/Deny. The step engine drains these
 * on its own schedule, so the UI never writes run state directly (no lost updates).
 */
export interface ApprovalDecision {
  id: string;
  runId: string;
  approvalId: string;
  decision: "approved" | "denied";
  note?: string;
  decidedAt: number;
}

// ---- Runs ----

export interface RunEvent {
  at: number;
  agentId?: string;
  message: string;
}

export interface Run {
  id: string;
  /** Owner key: lowercased email, or `github:<login>`. A user may only read their own runs. */
  ownerId: string;
  task: string;
  /** Optional repo in `owner/name` form. */
  repo?: string;
  /** Advanced options chosen at creation. */
  options?: RunOptions;
  /** Set when the run is started: the PC runner's queue or the cloud runner's. */
  placement?: Placement;
  status: RunStatus;
  plan?: Plan;
  /** Set when the Orchestrator writes the final report. */
  finalReport?: string;
  /** Repo mode only: branch `workflwpro/<runId>` and its PR. */
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  /** Total tokens across all agents. */
  tokens: number;
  agents: Agent[];
  approvals: Approval[];
  /** Activity log, newest last. Kept short by the engine. */
  events: RunEvent[];
  /** Human-readable failure reason, e.g. "Deadline of 24h exceeded". */
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** createdAt + RUN_DEADLINE_MS. */
  deadlineAt: number;
}

/** Written by the PC runner every ~15s to `runner:heartbeat` (expires after 45s). */
export interface RunnerHeartbeat {
  runnerId: string;
  pid: number;
  host: string;
  startedAt: number;
  /** Epoch ms when this beat was written. */
  ts: number;
}

/** What the site reports about the runner. `online` is false when the heartbeat key has expired. */
/**
 * Claude subscription usage, from the SDK's rate_limit_event (one per limit window, e.g. "five_hour",
 * "seven_day"). utilization is 0..1 (or 0..100 from some SDK versions); resetsAt is unix seconds.
 */
export interface UsageLimit {
  type: string;
  status: string;
  utilization?: number;
  resetsAt?: number;
  /** Epoch ms when the runner last saw it. */
  updatedAt: number;
}

/** Written by the PC runner when it pops a ping off its queue (runner:pong:<nonce>). */
export interface RunnerPong {
  nonce: string;
  host: string;
  runnerId: string;
  /** Epoch ms when the runner answered. */
  at: number;
}

export interface RunnerStatus {
  online: boolean;
  runnerId?: string;
  host?: string;
  startedAt?: number;
  lastSeen?: number;
}

/** An attachment uploaded for a draft run. Chunks are stored separately; see store.ts. */
export interface RunFile {
  id: string;
  runId: string;
  /** Basename only. No path separators. */
  name: string;
  /** Total raw bytes. */
  size: number;
  /** Raw bytes per chunk (UPLOAD_CHUNK_BYTES). */
  chunkBytes: number;
  /** ceil(size / chunkBytes). */
  chunks: number;
  /** True once every chunk is stored and the owner called complete. */
  complete: boolean;
  createdAt: number;
}

/** Lightweight entry for run history lists (kept in a per-owner index). */
export interface RunIndexEntry {
  id: string;
  ownerId: string;
  task: string;
  repo?: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
}

// ---- Orchestrator chat ----

/** Longest owner message the chat accepts. */
export const CHAT_MAX_CHARS = 4000;
/** Messages kept per chat (general or per run). Older ones are trimmed. */
export const CHAT_HISTORY_MAX = 200;

/**
 * One line in a chat. The chat is append-only: a reply is a new `orchestrator` message whose
 * `replyTo` is the owner message it answers. "Pending" means no reply has been appended yet.
 */
export interface ChatMessage {
  id: string;
  role: "owner" | "orchestrator";
  text: string;
  /** The run this chat is about. Absent for the general chat. */
  runId?: string;
  /** Orchestrator replies: the owner message they answer. */
  replyTo?: string;
  /** Set on an orchestrator reply that could not be produced; `text` then says why in plain words. */
  error?: string;
  /** Model that wrote an orchestrator reply. */
  model?: string;
  createdAt: number;
}

/** A queued question. The runner pops it, answers it and appends the reply to the same chat. */
export interface ChatJob {
  id: string;
  ownerId: string;
  /** Run the chat is about, or absent for the general chat. */
  runId?: string;
  /** The owner message being answered. */
  messageId: string;
  text: string;
  createdAt: number;
}

// ---- Session (auth) ----

export type AuthMethod = "github";

export interface SessionUser {
  /** Same key as Run.ownerId. */
  id: string;
  method: AuthMethod;
  /** GitHub login, for display. */
  display: string;
}
