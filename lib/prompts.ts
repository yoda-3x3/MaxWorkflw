// Prompts for each tier, condensed from .wdash/attachments/ORCHESTRATOR_PROMPT (2).md.
// Pure functions and constants: no I/O, no SDK.

import { MAX_AGENTS, MAX_DEPTH } from './types';
import type { ApprovalKind, Plan, PlanUnit, PlanWorker, TeamShape } from './types';

// The four hard stops (§1). Agents ask upward with an APPROVAL_REQUEST line; they never act.
export const HARD_STOP_RULES: ReadonlyArray<{ rule: number; kind: ApprovalKind; text: string }> = [
  { rule: 1, kind: 'production_deploy', text: 'Never deploy to production. Previews are fine.' },
  {
    rule: 2,
    kind: 'destructive_op',
    text: 'Never delete files or data, force-push, or run migrations.',
  },
  {
    rule: 3,
    kind: 'paid_or_secret',
    text: 'Never add a paid service, or create or touch secrets or credentials.',
  },
  {
    rule: 4,
    kind: 'budget_exceeded',
    text: 'Never exceed the approved budget: tokens, agents, or the 24-hour deadline.',
  },
];

export const HARD_STOP_SUMMARY = HARD_STOP_RULES.map((r) => `${r.rule} ${r.text}`).join(' ');

export const REPORT_FORMAT = [
  'STATUS: done | blocked | partial',
  'CHANGED: <file: one-line summary>',
  'VERIFIED: <command run and result, or "not run: reason">',
  'RISKS/OPEN: <anything the parent must decide or double-check>',
].join('\n');

export const DEFAULT_CONSTRAINTS =
  'Follow the project conventions you can see. No new dependencies. No secrets in code.';

const EXECUTION_NOTE =
  'You cannot execute code. Never claim a build, test or run passed. "Verified" means you checked it by reading, and you say so.';

const REPO_NOTE =
  'You work in a checkout of the project at your working directory. Read and edit files there with your tools. Commit nothing and push nothing: the runner does that. Never deploy and never touch secrets.';

const APPROVAL_NOTE =
  'Ordinary work, including code that might break, needs no approval: proceed. Only the hard stops pause you. If one applies, stop that step and make the last line of your reply exactly "APPROVAL_REQUEST rule=N: <one-line request>", with N the hard stop number. Other work continues.';

// ---- Brief template (§4) ----

export interface BriefFields {
  role: 'worker' | 'lead';
  model: string;
  goal: string;
  scope: string;
  context: string;
  constraints?: string;
  doneWhen: string;
  returnWords?: number;
}

// Exact §4 layout. Every agent gets this and nothing more.
export function renderBrief(f: BriefFields): string {
  return [
    `ROLE: ${f.role} (${f.model})`,
    `GOAL: ${f.goal}`,
    `SCOPE (exclusive): ${f.scope}`,
    `CONTEXT: ${f.context}`,
    `CONSTRAINTS: ${f.constraints ?? DEFAULT_CONSTRAINTS}`,
    `DONE WHEN: ${f.doneWhen}`,
    `HARD STOPS: ${HARD_STOP_SUMMARY} Ask upward, never act.`,
    `RETURN: report in the format below, max ${f.returnWords ?? 150} words.`,
    REPORT_FORMAT,
  ].join('\n');
}

// Fills the template from a planned unit or worker. The planner JSON has only a
// `brief` field, so that text becomes CONTEXT and the title becomes GOAL.
export function unitBrief(
  unit: PlanUnit | PlanWorker,
  role: 'worker' | 'lead',
  model: string,
): string {
  return renderBrief({
    role,
    model,
    goal: unit.title,
    scope: 'Exclusive to this agent. Touch only what CONTEXT names.',
    context: unit.brief,
    doneWhen: 'The acceptance check in CONTEXT is met, as far as reading can confirm it.',
  });
}

// ---- System prompts ----

export interface PlannerLimits {
  maxAgents?: number;
  maxDepth?: number;
  /** The owner's requested team shape (Advanced options). */
  shape?: TeamShape;
}

/** Extra planner instruction for a requested team shape; empty for auto. */
export function shapeInstruction(shape: TeamShape | undefined): string {
  if (shape === 'three-tier') {
    return 'The owner asked for a 3-tier team (you -> leads -> workers): give every unit "workers" (at least 2), so each unit is a lead that integrates its workers. Only leave out workers for a unit that truly cannot be split.';
  }
  if (shape === 'flat') return 'The owner asked for a flat team: no unit gets "workers". Every unit is one agent.';
  return '';
}

export function plannerSystemPrompt(limits: PlannerLimits = {}): string {
  const maxAgents = limits.maxAgents ?? MAX_AGENTS;
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  return [
    'You are the Orchestrator of WorkflwPro, a team of AI agents that plans, researches, writes code and ships work. You plan and delegate. You do not do the work.',
    '',
    'Split the task into units. Every unit has an exclusive scope (files, directories or questions). If two units would touch the same scope, merge them or sequence them with deps.',
    '',
    'Choose the shallowest structure that works:',
    '- Trivial: one unit, no workers.',
    '- Standard: a few independent units, no workers. Each unit becomes one agent.',
    '- Large: a unit that needs several parallel pieces gets "workers". It becomes a lead that integrates its workers\' reports.',
    `Never nest deeper than ${maxDepth} tiers. Fewest agents that finish fastest.`,
    ...(shapeInstruction(limits.shape) ? [shapeInstruction(limits.shape)] : []),
    '',
    `Limit: at most ${maxAgents} agents in total, counting you, every lead and every worker. Plan for fewer. Run independent units in parallel. Use deps only for true dependencies.`,
    '',
    'Output ONLY one JSON object. No prose, no code fences. Shape:',
    '{"summary": "...", "units": [{"id": "...", "title": "...", "brief": "...", "deps": [], "workers": [{"id": "...", "title": "...", "brief": "...", "deps": []}]}]}',
    '',
    '- summary: the goal and the definition of done, in at most 2 sentences. If you cut scope to fit the limit, say what was cut.',
    '- id: short kebab-case, unique across the whole plan, units and workers alike.',
    '- title: a few words.',
    '- brief: self-contained instructions. State the outcome, the exact scope, the inputs, and an objective acceptance check. The agent sees nothing else.',
    '- deps: unit ids that must finish first (for a worker: sibling worker ids). Empty array if none.',
    '- workers: leave out for a standalone unit. Include only when the unit is big enough to split.',
    '',
    `Hard stops, which agents must ask about and never act on: ${HARD_STOP_SUMMARY}`,
  ].join('\n');
}

export interface RepoContext {
  repo: string; // owner/name
}

export function plannerUserPrompt(task: string, repo?: RepoContext): string {
  const lines = ['TASK:', task.trim()];
  if (repo) {
    lines.push(
      '',
      `REPO: ${repo.repo}. Agents work in a checkout of it and edit files there. The runner commits to a dedicated branch; agents never push. Make scopes file paths or directories.`,
    );
  }
  return lines.join('\n');
}

export function workerSystemPrompt(): string {
  return [
    'You are a worker in WorkflwPro. Do the one bounded unit of work in your brief, then report back.',
    '',
    'Your brief is your whole scope. Stay inside SCOPE, follow CONSTRAINTS, and stop once DONE WHEN is met. Do not touch anything else.',
    '',
    EXECUTION_NOTE,
    REPO_NOTE,
    APPROVAL_NOTE,
    '',
    'Keep the report under 150 words. No logs, no whole files. Name paths, not contents.',
    '',
    'Report format:',
    REPORT_FORMAT,
  ].join('\n');
}

export function leadSystemPrompt(): string {
  return [
    'You are a lead in WorkflwPro. Your workers have finished. Integrate their reports into one result for the Orchestrator.',
    '',
    'You own your scope. Resolve overlaps and conflicts between your workers yourself. Do not redo their work unless integration needs it. Do not pass the same problem back and forth.',
    '',
    EXECUTION_NOTE,
    REPO_NOTE,
    APPROVAL_NOTE,
    '',
    'Keep the report under 150 words. No logs, no whole files.',
    '',
    'Report format:',
    REPORT_FORMAT,
    'ROLLUP: <one line: each worker\'s result, and any cross-worker overlap you resolved>',
  ].join('\n');
}

export function finalSystemPrompt(): string {
  return [
    'You are the Orchestrator writing the final report for the owner of WorkflwPro. The owner reads only this report, so it must stand alone.',
    '',
    'Use these sections, in this order:',
    '1. Outcome: one short paragraph.',
    '2. Done: bullets.',
    '3. Cut or not done: bullets, each with its reason. Write "None" if nothing was cut.',
    '4. Verification: what was run and its result. If nothing was run, say so. Agents cannot execute code.',
    '5. Risks and open decisions.',
    '6. Approvals needed: or "None".',
    '',
    'Be plain and short. Use only the unit reports you are given. Do not invent results.',
  ].join('\n');
}

// ---- User messages ----

export function workerUserPrompt(briefText: string): string {
  return briefText;
}

export interface WorkerReport {
  id: string;
  title: string;
  status: string;
  report: string;
}

// The lead's brief, then the clipped worker reports it integrates.
export function leadUserPrompt(briefText: string, workers: WorkerReport[]): string {
  return [briefText, '', 'WORKER REPORTS:', ...workers.map(formatReport)].join('\n');
}

export interface FinalInput {
  task: string;
  summary: string;
  units: WorkerReport[];
  cut?: string[];
  prUrl?: string;
}

export function finalUserPrompt(input: FinalInput): string {
  const lines = [
    'TASK:',
    input.task.trim(),
    '',
    'PLAN SUMMARY:',
    input.summary.trim(),
    '',
    'UNIT REPORTS:',
    ...input.units.map(formatReport),
  ];
  if (input.cut && input.cut.length > 0) {
    lines.push('', `CUT BY THE AGENT LIMIT: ${input.cut.join(', ')}`);
  }
  if (input.prUrl) lines.push('', `PR: ${input.prUrl}`);
  return lines.join('\n');
}

// Feeds the owner's decision into the paused agent's brief so it can resume.
export function approvalResumePrompt(args: {
  kind: ApprovalKind;
  decision: 'approved' | 'denied';
  note?: string;
}): string {
  const rule = HARD_STOP_RULES.find((r) => r.kind === args.kind);
  const label = rule ? `hard stop ${rule.rule} (${rule.text})` : args.kind;
  const lines = [`APPROVAL DECISION for ${label}: ${args.decision.toUpperCase()}.`];
  if (args.note) lines.push(`Owner note: ${args.note.trim()}`);
  lines.push(
    args.decision === 'approved'
      ? 'You may now take that step. Stay inside your scope.'
      : 'Do not take that step. Report STATUS: blocked for it, and finish the rest of your work.',
  );
  return lines.join('\n');
}

function formatReport(r: WorkerReport): string {
  return `- ${r.id} (${r.title}) [${r.status}]: ${clipReport(r.report)}`;
}

// Reports are clipped when passed upward. Cut at a line break when one is near the limit.
export function clipReport(text: string, maxChars = 1200): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = trimmed.slice(0, maxChars);
  const lastBreak = head.lastIndexOf('\n');
  const cut = lastBreak > maxChars * 0.6 ? head.slice(0, lastBreak) : head;
  return `${cut.trimEnd()}\n[... clipped]`;
}

// Chat with the owner. The Orchestrator answers in text only: it cannot start, change or approve work
// from here, so it says what the owner should do instead.
export function orchestratorChatSystemPrompt(): string {
  return [
    'You are the Orchestrator of WorkflwPro, a team of AI agents that plans, researches, writes code and ships work. You are talking with the owner, who started the work and decides on the hard stops.',
    '',
    'Answer the owner directly and plainly. When RUN CONTEXT is given, it is the run this chat is about: use its plan, agent reports, approvals and errors, and say when the context does not contain the answer. Do not invent agent results.',
    '',
    'You cannot start runs, edit files, approve or deny anything, or change a run from this chat. If the owner asks for that, say what to do instead (for example: start a run from the New run form, or answer the pending approval card on the run).',
    '',
    `Hard stops, which agents must ask the owner about and never act on: ${HARD_STOP_SUMMARY}`,
    '',
    'Keep replies short. Use plain text with short lists when they help. No code fences unless the owner asks for code.',
  ].join('\n');
}

// ---- Plan parsing, validation and the agent cap ----

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
}

// Accepts raw JSON, a fenced ```json block, or JSON surrounded by prose.
export function parsePlan(text: string): Plan {
  const trimmed = text.trim();
  let candidate = trimmed;
  if (!trimmed.startsWith('{')) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fenced) {
      candidate = fenced[1].trim();
    } else {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end > start) candidate = trimmed.slice(start, end + 1);
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    throw new PlanParseError('Plan is not valid JSON');
  }
  return validatePlan(raw);
}

export function validatePlan(raw: unknown): Plan {
  const errors: string[] = [];
  const obj = isRecord(raw) ? raw : undefined;
  if (!obj) throw new PlanParseError('Plan must be a JSON object');

  if (!isNonEmptyString(obj.summary)) errors.push('summary must be a non-empty string');
  if (!Array.isArray(obj.units) || obj.units.length === 0) {
    errors.push('units must be a non-empty array');
  }

  const units: PlanUnit[] = [];
  const seen = new Set<string>();
  const unitIds = new Set<string>();

  const checkId = (id: unknown, where: string) => {
    if (!isNonEmptyString(id)) {
      errors.push(`${where} needs a non-empty id`);
      return false;
    }
    if (seen.has(id)) errors.push(`duplicate id "${id}"`);
    seen.add(id);
    return true;
  };

  if (Array.isArray(obj.units)) {
    for (const [i, u] of obj.units.entries()) {
      if (!isRecord(u)) {
        errors.push(`units[${i}] must be an object`);
        continue;
      }
      const where = `units[${i}]`;
      const id = checkId(u.id, where) ? (u.id as string) : '';
      if (id) unitIds.add(id);
      if (!isNonEmptyString(u.title)) errors.push(`${where} needs a title`);
      if (!isNonEmptyString(u.brief)) errors.push(`${where} needs a brief`);

      const deps = stringArray(u.deps, `${where}.deps`, errors);
      const workers = parseWorkers(u.workers, where, errors, checkId);

      units.push({
        id,
        title: String(u.title ?? ''),
        brief: String(u.brief ?? ''),
        deps,
        ...(workers ? { workers } : {}),
      });
    }
  }

  // Unit deps must name other units; worker deps must name sibling workers.
  for (const u of units) {
    for (const d of u.deps) {
      if (d === u.id) errors.push(`unit "${u.id}" depends on itself`);
      else if (!unitIds.has(d)) errors.push(`unit "${u.id}" depends on unknown unit "${d}"`);
    }
    const workerIds = new Set((u.workers ?? []).map((w) => w.id));
    for (const w of u.workers ?? []) {
      for (const d of w.deps ?? []) {
        if (d === w.id) errors.push(`worker "${w.id}" depends on itself`);
        else if (!workerIds.has(d)) errors.push(`worker "${w.id}" depends on unknown worker "${d}"`);
      }
    }
  }

  if (errors.length === 0) {
    const cycle = findCycle(units.map((u) => ({ id: u.id, deps: u.deps })));
    if (cycle) errors.push(`dependency cycle: ${cycle}`);
    for (const u of units) {
      const c = findCycle((u.workers ?? []).map((w) => ({ id: w.id, deps: w.deps ?? [] })));
      if (c) errors.push(`dependency cycle in unit "${u.id}": ${c}`);
    }
  }

  if (errors.length > 0) throw new PlanParseError(errors.join('; '));
  return {
    summary: String(obj.summary).trim(),
    units,
  };
}

// Orchestrator counts as one agent. A unit counts as one (a worker), or as one lead
// plus its workers.
export function unitCost(unit: PlanUnit): number {
  return unit.workers ? 1 + unit.workers.length : 1;
}

export function countAgents(plan: Plan): number {
  return 1 + plan.units.reduce((sum, u) => sum + unitCost(u), 0);
}

// Keeps units in plan order while they fit under maxAgents (the Orchestrator takes one
// slot). A unit is cut whole, along with any unit that depends on a cut unit.
export function capPlan(plan: Plan, maxAgents = MAX_AGENTS): { plan: Plan; cut: string[] } {
  let budget = maxAgents - 1;
  const kept = new Set<string>();
  const units: PlanUnit[] = [];
  const cut: string[] = [];

  for (const u of plan.units) {
    const depsKept = u.deps.every((d) => kept.has(d));
    const cost = unitCost(u);
    if (depsKept && cost <= budget) {
      kept.add(u.id);
      units.push(u);
      budget -= cost;
    } else {
      cut.push(u.id);
    }
  }

  return { plan: { summary: plan.summary, units }, cut };
}

// ---- helpers ----

function parseWorkers(
  value: unknown,
  where: string,
  errors: string[],
  checkId: (id: unknown, where: string) => boolean,
): PlanWorker[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${where}.workers must be an array`);
    return undefined;
  }
  if (value.length === 0) return undefined; // empty list means a standalone unit

  const workers: PlanWorker[] = [];
  for (const [j, w] of value.entries()) {
    const wWhere = `${where}.workers[${j}]`;
    if (!isRecord(w)) {
      errors.push(`${wWhere} must be an object`);
      continue;
    }
    const id = checkId(w.id, wWhere) ? (w.id as string) : '';
    if (!isNonEmptyString(w.title)) errors.push(`${wWhere} needs a title`);
    if (!isNonEmptyString(w.brief)) errors.push(`${wWhere} needs a brief`);
    const deps = stringArray(w.deps, `${wWhere}.deps`, errors);
    workers.push({
      id,
      title: String(w.title ?? ''),
      brief: String(w.brief ?? ''),
      deps,
    });
  }
  return workers;
}

function stringArray(value: unknown, where: string, errors: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    errors.push(`${where} must be an array of strings`);
    return [];
  }
  return value as string[];
}

// Returns a human-readable cycle path, or undefined when the graph is acyclic.
function findCycle(nodes: Array<{ id: string; deps: string[] }>): string | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string | undefined => {
    const s = state.get(id);
    if (s === 'done') return undefined;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(id)), id].join(' -> ');
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of byId.get(id)?.deps ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const n of nodes) {
    const c = visit(n.id);
    if (c) return c;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
