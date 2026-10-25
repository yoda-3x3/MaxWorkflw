// Step engine. One step() call does one unit of work: plan, one wave of ready
// agents (run in parallel), or finalize. Callers chain the next step.
//
// Prompts, plan parsing and the agent cap live in prompts.ts. The model loop is
// claude.ts's runAgent. Repo access goes through github.ts, which enforces path
// policy. The engine's GitHub dependency omits mergePR, so it cannot merge.

import { AGENT_MAX_ATTEMPTS, AGENT_STALL_MS, MAX_AGENTS, RUN_DEADLINE_MS } from './types'
import type { Agent, ApprovalDecision, ApprovalKind, Plan, Run } from './types'
import {
  createAnthropicClient,
  resolveModels,
  runAgent,
  type ClaudeClient,
  type Models,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from './claude'
import {
  HARD_STOP_RULES,
  approvalResumePrompt,
  capPlan,
  clipReport,
  finalSystemPrompt,
  finalUserPrompt,
  leadSystemPrompt,
  leadUserPrompt,
  parsePlan,
  plannerSystemPrompt,
  plannerUserPrompt,
  unitBrief,
  workerSystemPrompt,
  workerUserPrompt,
  type WorkerReport,
} from './prompts'
import { branchForRun, createGitHubClient, type GitHubClient } from './github'
import { getRunStore, type RunStore } from './store'

export type EngineStore = Pick<
  RunStore,
  'saveRun' | 'getRunForEngine' | 'acquireRunLock' | 'releaseRunLock' | 'drainDecisions'
>

export type EngineGitHub = Pick<GitHubClient, 'listFiles' | 'readFile' | 'writeFile' | 'openPR'>

export interface EngineDeps {
  claude: ClaudeClient
  github: (repo: string) => EngineGitHub
  store: EngineStore
  models: Models
  now: () => number
}

export interface StepResult {
  runId: string
  action: 'planned' | 'replan' | 'wave' | 'waiting' | 'finalized' | 'failed' | 'idle' | 'locked'
  // True when another step should run now. The UI or cron re-kicks after `waiting`.
  more: boolean
}

const LOCK_TTL_SEC = 300
// Model calls per agent turn-loop. Exceeding this fails the attempt.
const MAX_AGENT_CALLS = 8
const REPORT_STORE_CHARS = 4000
const FINAL_REPORT_MAX_CHARS = 8000
const EVENTS_MAX = 500
const REPO_LIST_MAX = 500
const REPO_READ_MAX_CHARS = 20_000
const REPO_WRITE_MAX_CHARS = 100_000
const CUT_EVENT = 'cut by agent limit: unit '

// Thrown from a tool executor to stop the agent loop at once. The approval pauses only this agent.
class ApprovalPause extends Error {}

const APPROVAL_TOOL: ToolDefinition = {
  name: 'request_approval',
  description:
    'Pause only this agent and ask the owner. Use only for a hard stop: 1 production deploy, 2 delete/force-push/migration, 3 new paid service or secrets, 4 exceeding budget.',
  input_schema: {
    type: 'object',
    properties: {
      rule: { type: 'integer', enum: [1, 2, 3, 4] },
      request: { type: 'string' },
    },
    required: ['rule', 'request'],
  },
}

const REPO_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description: 'List files in the repo. Reads the run branch once it has writes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_file',
    description: 'Read a repo file by relative path.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Write a repo file. Writes go only to the run branch.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
]

function addEvent(run: Run, message: string, now: number, agentId?: string) {
  run.events.push({ at: now, message, agentId })
  if (run.events.length > EVENTS_MAX) run.events.splice(0, run.events.length - EVENTS_MAX)
}

function addUsage(run: Run, agent: Agent | undefined, input: number, output: number) {
  run.tokens += input + output
  if (agent) agent.tokens += input + output
}

// Builds a queued run and saves it. Returns the saved record.
export async function createRun(
  args: { ownerId: string; task: string; repo?: string; now?: number; id?: string },
  overrides: Partial<EngineDeps> = {},
): Promise<Run> {
  const run = buildRun(args)
  const store = overrides.store ?? configured.store ?? getRunStore()
  await store.saveRun(run)
  return run
}

export function buildRun(args: { ownerId: string; task: string; repo?: string; now?: number; id?: string }): Run {
  const now = args.now ?? Date.now()
  const id = args.id ?? crypto.randomUUID()
  return {
    id,
    ownerId: args.ownerId,
    task: args.task,
    repo: args.repo,
    status: 'queued',
    tokens: 0,
    agents: [
      {
        id: 'orch',
        runId: id,
        parentId: null,
        tier: 1,
        role: 'orchestrator',
        title: 'Orchestrator',
        model: '',
        status: 'queued',
        brief: args.task,
        deps: [],
        attempts: 0,
        tokens: 0,
        createdAt: now,
      },
    ],
    approvals: [],
    events: [{ at: now, message: 'Run created' }],
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + RUN_DEADLINE_MS,
  }
}

// Builds agent records for a validated plan (capPlan has already applied the cap).
// Tier counts depth from the orchestrator. A lead or a standalone worker is tier 2,
// and a lead's workers are tier 3. A standalone worker runs on the lead model, and a
// leaf worker on the worker model. Unit deps map to the unit's top agent (its lead,
// or its standalone worker). Worker deps map to sibling worker agents.
export function buildAgents(plan: Plan, runId: string, orchId: string, models: Models, now: number): Agent[] {
  const agents: Agent[] = []
  const topOf = new Map<string, Agent>()
  const agentOf = new Map<string, Agent>()
  let n = 0
  const make = (over: Pick<Agent, 'title' | 'brief' | 'model' | 'tier' | 'role' | 'parentId'>): Agent => ({
    id: `a${++n}`,
    runId,
    status: 'queued',
    deps: [],
    attempts: 0,
    tokens: 0,
    createdAt: now,
    ...over,
  })

  for (const u of plan.units) {
    if (!u.workers || u.workers.length === 0) {
      const a = make({
        title: u.title,
        brief: unitBrief(u, 'worker', models.lead),
        model: models.lead,
        tier: 2,
        role: 'worker',
        parentId: orchId,
      })
      agents.push(a)
      topOf.set(u.id, a)
      continue
    }
    const lead = make({
      title: u.title,
      brief: unitBrief(u, 'lead', models.lead),
      model: models.lead,
      tier: 2,
      role: 'lead',
      parentId: orchId,
    })
    agents.push(lead)
    topOf.set(u.id, lead)
    for (const w of u.workers) {
      const wa = make({
        title: w.title,
        brief: unitBrief(w, 'worker', models.worker),
        model: models.worker,
        tier: 3,
        role: 'worker',
        parentId: lead.id,
      })
      agents.push(wa)
      agentOf.set(w.id, wa)
      lead.deps.push(wa.id)
    }
  }
  for (const u of plan.units) {
    topOf.get(u.id)!.deps.push(...(u.deps ?? []).map((d) => topOf.get(d)!.id))
    for (const w of u.workers ?? []) {
      agentOf.get(w.id)!.deps.push(...(w.deps ?? []).map((d) => agentOf.get(d)!.id))
    }
  }
  return agents
}

// Queued non-orchestrator agents whose deps are all done, in order.
export function selectReady(agents: Agent[]): Agent[] {
  const done = new Set(agents.filter((a) => a.status === 'done').map((a) => a.id))
  return agents.filter(
    (a) => a.role !== 'orchestrator' && a.status === 'queued' && a.deps.every((d) => done.has(d)),
  )
}

// attempts counts starts (incremented when an attempt begins), so AGENT_MAX_ATTEMPTS = 2
// means one retry. A failed attempt is requeued while attempts remain, and failed once
// they run out. Returns a log line.
// `terminal` is true when the agent is now failed. Callers branch on it instead of
// comparing agent.status, which TypeScript narrows after earlier assignments.
export function failAgent(agent: Agent, reason: string, now: number): { line: string; terminal: boolean } {
  if (agent.attempts < AGENT_MAX_ATTEMPTS) {
    agent.status = 'queued'
    agent.startedAt = undefined
    return { line: `${agent.id} ${agent.title}: ${reason}; retrying`, terminal: false }
  }
  agent.status = 'failed'
  agent.error = reason
  agent.endedAt = now
  return {
    line: `${agent.id} ${agent.title}: ${reason}; failed after ${agent.attempts} attempts`,
    terminal: true,
  }
}

// Agents stuck in running past the timeout go through the same retry-or-fail path.
export function recoverStuck(agents: Agent[], now: number, timeoutMs: number = AGENT_STALL_MS): string[] {
  const msgs: string[] = []
  for (const a of agents) {
    if (a.status === 'running' && a.startedAt !== undefined && now - a.startedAt > timeoutMs) {
      msgs.push(failAgent(a, 'stuck in running past timeout', now).line)
    }
  }
  return msgs
}

// Fails queued agents whose dependency failed, transitively.
export function blockFailed(agents: Agent[], now: number): string[] {
  const msgs: string[] = []
  let changed = true
  while (changed) {
    changed = false
    const failed = new Set(agents.filter((a) => a.status === 'failed').map((a) => a.id))
    for (const a of agents) {
      if (a.status !== 'queued' || a.role === 'orchestrator') continue
      const bad = a.deps.find((d) => failed.has(d))
      if (bad) {
        a.status = 'failed'
        a.error = `blocked by failed dependency ${bad}`
        a.endedAt = now
        msgs.push(`${a.id} ${a.title}: blocked by failed ${bad}`)
        changed = true
      }
    }
  }
  return msgs
}

// Applies drained decisions. Each one resolves its approval and resumes only the agent
// that asked. The decision text goes into that agent's brief.
export function applyDecisions(run: Run, decisions: ApprovalDecision[], now: number): string[] {
  const msgs: string[] = []
  for (const d of decisions) {
    const ap = run.approvals.find((x) => x.id === d.approvalId)
    if (!ap || ap.status !== 'pending') continue
    ap.status = d.decision
    ap.note = d.note
    ap.decidedAt = d.decidedAt ?? now
    const agent = run.agents.find((a) => a.id === ap.agentId)
    if (!agent || agent.status !== 'waiting_approval') continue
    agent.brief += `\n\n${approvalResumePrompt({ kind: ap.kind, decision: d.decision, note: d.note })}`
    agent.status = 'queued'
    agent.approvalId = undefined
    // Resuming after an approval is not a retry, so refund the attempt the pause used.
    agent.attempts = Math.max(0, agent.attempts - 1)
    msgs.push(`${agent.id} ${agent.title}: approval ${d.decision}, resuming`)
  }
  return msgs
}

// Reads the request_approval input. Rule numbers map to the hard stops in prompts.ts.
export function parseApprovalInput(input: unknown): { kind: ApprovalKind; request: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const { rule, request } = input as Record<string, unknown>
  const hit = HARD_STOP_RULES.find((r) => r.rule === rule)
  if (!hit || typeof request !== 'string' || request.trim() === '') return null
  return { kind: hit.kind, request: request.trim() }
}

function reportOf(a: Agent): string {
  if (a.report) return a.report
  if (a.error) return `FAILED: ${a.error}`
  return '(no report)'
}

function toWorkerReport(a: Agent): WorkerReport {
  return { id: a.id, title: a.title, status: a.status, report: reportOf(a) }
}

function promptFor(agent: Agent, run: Run): string {
  if (agent.role === 'lead' || agent.deps.length > 0) {
    const reports = agent.deps
      .map((d) => run.agents.find((a) => a.id === d))
      .filter((a): a is Agent => a !== undefined)
      .map(toWorkerReport)
    return leadUserPrompt(agent.brief, reports)
  }
  return workerUserPrompt(agent.brief)
}

function systemFor(agent: Agent): string {
  return agent.role === 'lead' ? leadSystemPrompt() : workerSystemPrompt()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

async function execRepoTool(call: ToolCall, run: Run, agent: Agent, deps: EngineDeps): Promise<ToolResult> {
  const gh = deps.github(run.repo!)
  const input = (call.input ?? {}) as Record<string, unknown>
  if (call.name === 'list_files') {
    const entries = await gh.listFiles(run.id)
    return entries.slice(0, REPO_LIST_MAX).map((e) => e.path).join('\n') || '(no files)'
  }
  if (call.name === 'read_file') {
    const file = await gh.readFile(run.id, str(input.path))
    return clipReport(file.content, REPO_READ_MAX_CHARS)
  }
  if (call.name === 'write_file') {
    const path = str(input.path)
    const content = str(input.content)
    if (content.length > REPO_WRITE_MAX_CHARS) throw new Error('file too large')
    await gh.writeFile(run.id, path, content)
    run.branch = branchForRun(run.id)
    addEvent(run, `wrote ${path}`, deps.now(), agent.id)
    return `ok: wrote ${path}`
  }
  return { content: `unknown tool ${call.name}`, isError: true }
}

type AgentOutcome = { kind: 'done'; report: string } | { kind: 'approval'; approval: { kind: ApprovalKind; request: string } }

// One agent's turn loop. request_approval stops this agent right away, and only this agent.
async function runOneAgent(agent: Agent, run: Run, deps: EngineDeps): Promise<AgentOutcome> {
  const tools: ToolDefinition[] = [APPROVAL_TOOL]
  if (run.repo && agent.role !== 'orchestrator') tools.push(...REPO_TOOLS)
  const pause = new AbortController()
  const state: { pending?: { kind: ApprovalKind; request: string } } = {}
  try {
    const res = await runAgent({
      client: deps.claude,
      model: agent.model,
      system: systemFor(agent),
      prompt: promptFor(agent, run),
      tools,
      maxTokens: 2000,
      maxIterations: MAX_AGENT_CALLS,
      signal: pause.signal,
      executeTool: async (call) => {
        if (call.name !== 'request_approval') return execRepoTool(call, run, agent, deps)
        const req = parseApprovalInput(call.input)
        if (!req) return { content: 'request_approval needs rule 1-4 and a request', isError: true }
        state.pending = req
        pause.abort(new ApprovalPause('paused for approval'))
        return 'Paused. Wait for the owner.'
      },
    })
    addUsage(run, agent, res.usage.input_tokens, res.usage.output_tokens)
    return { kind: 'done', report: clipReport(res.text, REPORT_STORE_CHARS) }
  } catch (err) {
    if (err instanceof ApprovalPause && state.pending) return { kind: 'approval', approval: state.pending }
    throw err
  }
}

async function save(run: Run, deps: EngineDeps, now: number) {
  run.updatedAt = now
  await deps.store.saveRun(run)
}

function failRun(run: Run, reason: string, deps: EngineDeps, now: number): Promise<StepResult> {
  run.status = 'failed'
  run.error = reason
  for (const a of run.agents) {
    if (a.status === 'queued' || a.status === 'running' || a.status === 'waiting_approval') {
      a.status = 'failed'
      a.error = `run ended: ${reason}`
      a.endedAt = now
    }
  }
  addEvent(run, `Run failed: ${reason}`, now)
  return save(run, deps, now).then(() => ({ runId: run.id, action: 'failed' as const, more: false }))
}

async function planStep(run: Run, deps: EngineDeps, now: number): Promise<StepResult> {
  const orch = run.agents.find((a) => a.role === 'orchestrator')!
  orch.status = 'running'
  orch.model = deps.models.orchestrator
  orch.attempts += 1
  orch.startedAt = now
  run.status = 'planning'
  addEvent(run, 'Planning', now, orch.id)
  try {
    const res = await runAgent({
      client: deps.claude,
      model: deps.models.orchestrator,
      system: plannerSystemPrompt(),
      prompt: plannerUserPrompt(run.task, run.repo ? { repo: run.repo } : undefined),
      maxTokens: 4000,
      maxIterations: 1,
    })
    addUsage(run, orch, res.usage.input_tokens, res.usage.output_tokens)
    const { plan, cut } = capPlan(parsePlan(res.text), MAX_AGENTS)
    if (plan.units.length === 0) throw new Error('no units fit the agent cap')
    for (const id of cut) addEvent(run, `${CUT_EVENT}${id}`, now, orch.id)
    run.plan = plan
    run.agents.push(...buildAgents(plan, run.id, orch.id, deps.models, now))
    orch.status = 'done'
    orch.report = plan.summary
    orch.endedAt = now
    run.status = 'running'
    addEvent(run, `Plan: ${plan.units.length} unit(s), ${run.agents.length - 1} agent(s)`, now, orch.id)
    await save(run, deps, now)
    return { runId: run.id, action: 'planned', more: true }
  } catch (err) {
    const msg = (err as Error).message
    // A failure after the plan was attached (e.g. save threw) must not leave a half-applied
    // plan behind. Roll the run back to "no plan", so the retry plans from scratch.
    run.plan = undefined
    run.agents = run.agents.filter((a) => a.role === 'orchestrator')
    orch.status = 'running'
    orch.report = undefined
    orch.endedAt = undefined
    addEvent(run, `Plan attempt failed: ${msg}`, now, orch.id)
    const outcome = failAgent(orch, msg, now)
    if (outcome.terminal) return failRun(run, `planner failed: ${msg}`, deps, now)
    addEvent(run, outcome.line, now, orch.id)
    orch.startedAt = undefined
    await save(run, deps, now)
    return { runId: run.id, action: 'replan', more: true }
  }
}

async function waveStep(run: Run, ready: Agent[], deps: EngineDeps, now: number): Promise<StepResult> {
  for (const a of ready) {
    a.status = 'running'
    a.attempts += 1
    a.startedAt = now
  }
  run.status = 'running'
  addEvent(run, `Wave: ${ready.length} agent(s) running in parallel`, now)
  await save(run, deps, now)

  const results = await Promise.all(
    ready.map((a) =>
      runOneAgent(a, run, deps).then(
        (outcome) => ({ a, outcome }),
        (err: unknown) => ({ a, err: err as Error }),
      ),
    ),
  )

  const end = deps.now()
  for (const r of results) {
    const a = r.a
    if ('err' in r) {
      addEvent(run, failAgent(a, r.err.message, end).line, end, a.id)
      continue
    }
    if (r.outcome.kind === 'approval') {
      const { kind, request } = r.outcome.approval
      const ap = {
        id: `${a.id}-ap${run.approvals.length + 1}`,
        runId: run.id,
        agentId: a.id,
        kind,
        request,
        status: 'pending' as const,
        createdAt: end,
      }
      run.approvals.push(ap)
      a.status = 'waiting_approval'
      a.approvalId = ap.id
      addEvent(run, `waiting for approval (${kind})`, end, a.id)
      continue
    }
    a.status = 'done'
    a.report = r.outcome.report
    a.endedAt = end
    addEvent(run, 'done', end, a.id)
  }
  await save(run, deps, end)
  return { runId: run.id, action: 'wave', more: true }
}

async function finalStep(run: Run, deps: EngineDeps, now: number): Promise<StepResult> {
  run.status = 'finalizing'
  await save(run, deps, now)
  const units = run.agents.filter((a) => a.role !== 'orchestrator').map(toWorkerReport)
  const cut = run.events.filter((e) => e.message.startsWith(CUT_EVENT)).map((e) => e.message.slice(CUT_EVENT.length))
  try {
    const res = await runAgent({
      client: deps.claude,
      model: deps.models.orchestrator,
      system: finalSystemPrompt(),
      prompt: finalUserPrompt({ task: run.task, summary: run.plan?.summary ?? '', units, cut }),
      maxTokens: 4000,
      maxIterations: 1,
    })
    addUsage(run, run.agents.find((a) => a.role === 'orchestrator'), res.usage.input_tokens, res.usage.output_tokens)
    run.finalReport = clipReport(res.text, FINAL_REPORT_MAX_CHARS)
  } catch (err) {
    addEvent(run, `Final report failed, using unit reports: ${(err as Error).message}`, now)
    run.finalReport = clipReport(
      units.map((u) => `- ${u.title} [${u.status}]: ${clipReport(u.report, 300)}`).join('\n'),
      FINAL_REPORT_MAX_CHARS,
    )
  }

  // Opens a PR only when the run wrote to its branch. Never merges.
  if (run.repo && run.branch) {
    try {
      const pr = await deps.github(run.repo).openPR(run.id, {
        title: `MaxWorkflw: ${run.task.slice(0, 60)}`,
        body: run.finalReport ?? '',
      })
      run.prUrl = pr.url
      run.prNumber = pr.number
      addEvent(run, `PR opened: ${pr.url}`, now)
    } catch (err) {
      addEvent(run, `PR not opened: ${(err as Error).message}`, now)
    }
  }
  run.status = 'done'
  addEvent(run, 'Run finished', now)
  await save(run, deps, now)
  return { runId: run.id, action: 'finalized', more: false }
}

async function drive(runId: string, deps: EngineDeps): Promise<StepResult> {
  const run = await deps.store.getRunForEngine(runId)
  if (!run) throw new Error(`run ${runId} not found`)
  if (run.status === 'done' || run.status === 'failed') return { runId, action: 'idle', more: false }

  const now = deps.now()
  for (const m of applyDecisions(run, await deps.store.drainDecisions(runId), now)) addEvent(run, m, now)
  if (now > run.deadlineAt) return failRun(run, 'Deadline exceeded: not finished within 24 hours', deps, now)
  for (const m of recoverStuck(run.agents, now)) addEvent(run, m, now)
  const orch = run.agents.find((a) => a.role === 'orchestrator')!
  if (orch.status === 'failed') return failRun(run, `planner failed: ${orch.error ?? ''}`, deps, now)
  if (!run.plan) return planStep(run, deps, now)

  for (const m of blockFailed(run.agents, now)) addEvent(run, m, now)
  const ready = selectReady(run.agents)
  if (ready.length > 0) return waveStep(run, ready, deps, now)

  // Nothing can run. If agents hold approvals, the run waits on the owner. Otherwise it finalizes.
  if (run.agents.some((a) => a.status === 'waiting_approval')) {
    run.status = 'waiting_approval'
    await save(run, deps, now)
    return { runId, action: 'waiting', more: false }
  }
  const open = run.agents.some((a) => a.role !== 'orchestrator' && (a.status === 'queued' || a.status === 'running'))
  if (open) return failRun(run, 'no runnable agents (dependency deadlock)', deps, now)
  return finalStep(run, deps, now)
}

// Production wiring, built only when a step has no injected deps. Needs
// ANTHROPIC_API_KEY, GITHUB_TOKEN and the Upstash env the store reads.
function envDeps(): EngineDeps {
  const env = process.env
  return {
    claude: createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY ?? '' }),
    github: (repo) => {
      const [owner, name] = repo.split('/')
      return createGitHubClient({ owner, repo: name, token: env.GITHUB_TOKEN ?? '' })
    },
    store: getRunStore(),
    models: resolveModels(env, true),
    now: () => Date.now(),
  }
}

let configured: Partial<EngineDeps> = {}

// Sets default deps once at boot. step() also takes per-call overrides.
export function configureEngine(deps: Partial<EngineDeps>): void {
  configured = { ...configured, ...deps }
}

function resolveDeps(overrides: Partial<EngineDeps>): EngineDeps {
  const merged = { ...configured, ...overrides }
  const env = merged.claude && merged.github && merged.store ? undefined : envDeps()
  return {
    claude: merged.claude ?? env!.claude,
    github: merged.github ?? env!.github,
    store: merged.store ?? env!.store,
    models: merged.models ?? resolveModels(),
    now: merged.now ?? (() => Date.now()),
  }
}

// Does exactly one unit of work for the run, under the per-run lock.
export async function step(runId: string, overrides: Partial<EngineDeps> = {}): Promise<StepResult> {
  const deps = resolveDeps(overrides)
  const token = await deps.store.acquireRunLock(runId, LOCK_TTL_SEC)
  if (!token) return { runId, action: 'locked', more: false }
  try {
    return await drive(runId, deps)
  } finally {
    await deps.store.releaseRunLock(runId, token)
  }
}

// Route-facing form. POST /api/runs/:id/step and the kick routes only need `more`.
export async function runStep(runId: string, overrides: Partial<EngineDeps> = {}): Promise<{ more: boolean }> {
  const r = await step(runId, overrides)
  return { more: r.more }
}
