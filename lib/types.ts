// Shared contract for MaxWorkflw. Every unit (auth, store, engine, UI, ...) imports from here.
// Keep this file types-and-constants only; no I/O.

// ---- Limits (enforced in the engine, not just the prompt) ----

/** Max agents per run, counted across all tiers including the Orchestrator. */
export const MAX_AGENTS = 15;

/** Max tiers: Orchestrator (1) -> Lead (2) -> Worker (3). */
export const MAX_DEPTH = 3;

/** Every run must finish within this many ms of creation, or it fails with a clear message. */
export const RUN_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** An agent stuck in `running` longer than this is reset to `queued` by the engine. */
export const AGENT_STALL_MS = 5 * 60 * 1000;

/** Each agent gets this many attempts in total (one retry) before it is marked failed. */
export const AGENT_MAX_ATTEMPTS = 2;

// ---- Tiers, roles, models ----

/** 1 = Orchestrator, 2 = Lead, 3 = Worker. */
export type Tier = 1 | 2 | 3;

export type AgentRole = "orchestrator" | "lead" | "worker";

/** Model IDs. Defaults come from env (ORCHESTRATOR_MODEL, LEAD_MODEL, WORKER_MODEL). */
export type ModelId = string;

// ---- Statuses ----

export type RunStatus =
  | "queued" // created, plan not started yet
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
  status: RunStatus;
  plan?: Plan;
  /** Set when the Orchestrator writes the final report. */
  finalReport?: string;
  /** Repo mode only: branch `maxworkflw/<runId>` and its PR. */
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

// ---- Session (auth) ----

export type AuthMethod = "github";

export interface SessionUser {
  /** Same key as Run.ownerId. */
  id: string;
  method: AuthMethod;
  /** GitHub login, for display. */
  display: string;
}
