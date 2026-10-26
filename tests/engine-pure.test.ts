import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDecisions,
  blockFailed,
  buildAgents,
  failAgent,
  parseApprovalInput,
  recoverStuck,
  selectReady,
} from '../lib/engine'
import { capPlan } from '../lib/prompts'
import { AGENT_STALL_MS, MAX_AGENTS, type Agent, type Plan, type Run } from '../lib/types'

const models = { orchestrator: 'opus', lead: 'sonnet', worker: 'haiku' }

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    runId: 'r1',
    parentId: 'orch',
    tier: 2,
    role: 'worker',
    title: over.id,
    model: 'm',
    status: 'queued',
    brief: 'b',
    deps: [],
    attempts: 0,
    tokens: 0,
    createdAt: 0,
    ...over,
  }
}

function unit(id: string, workers = 0, deps: string[] = []) {
  return {
    id,
    title: `T ${id}`,
    brief: `brief ${id}`,
    deps,
    ...(workers > 0
      ? { workers: Array.from({ length: workers }, (_, i) => ({ id: `${id}-w${i}`, title: `${id}w${i}`, brief: `wb${i}`, deps: [] })) }
      : {}),
  }
}

function runWith(agents: Agent[], approvals: Run['approvals'] = []): Run {
  return {
    id: 'r1',
    ownerId: 'me',
    task: 't',
    status: 'running',
    tokens: 0,
    agents: [agent({ id: 'orch', role: 'orchestrator', tier: 1, parentId: null }), ...agents],
    approvals,
    events: [],
    createdAt: 0,
    updatedAt: 0,
    deadlineAt: 1_000_000,
  }
}

test('buildAgents: a unit with workers becomes a lead that waits on its workers', () => {
  const plan: Plan = { summary: 's', units: [unit('a', 2) as Plan['units'][number]] }
  const agents = buildAgents(plan, 'r1', 'orch', models, 0)
  const lead = agents.find((a) => a.role === 'lead')!
  const workers = agents.filter((a) => a.parentId === lead.id)
  assert.equal(lead.tier, 2)
  assert.equal(workers.length, 2)
  assert.ok(workers.every((w) => w.tier === 3 && w.model === 'haiku'))
  assert.deepEqual(lead.deps.slice().sort(), workers.map((w) => w.id).sort())
  assert.ok(agents.every((a) => a.runId === 'r1' && a.status === 'queued' && a.attempts === 0))
})

test('buildAgents: a unit without workers is a standalone sonnet worker, and unit deps resolve to its top agent', () => {
  const plan: Plan = {
    summary: 's',
    units: [unit('a', 1) as Plan['units'][number], unit('b', 0, ['a']) as Plan['units'][number]],
  }
  const agents = buildAgents(plan, 'r1', 'orch', models, 0)
  const lead = agents.find((a) => a.role === 'lead')!
  const standalone = agents.find((a) => a.role === 'worker' && a.tier === 2)!
  assert.equal(standalone.model, 'sonnet')
  assert.equal(standalone.parentId, 'orch')
  assert.deepEqual(standalone.deps, [lead.id])
})

test('caps: an over-budget plan is truncated to MAX_AGENTS including the orchestrator, and the cut is reported', () => {
  // Each lead-plus-6-workers unit costs 7 agents. Four fill 28 of the 29 planned slots. A standalone
  // unit (cost 1) fills the last slot, so the fifth heavy unit and the trailing standalone are cut.
  const raw: Plan = {
    summary: 's',
    units: [unit('a', 6), unit('b', 6), unit('c', 6), unit('d', 6), unit('e'), unit('f'), unit('g', 6)] as Plan['units'],
  }
  const { plan, cut } = capPlan(raw, MAX_AGENTS)
  assert.deepEqual(
    plan.units.map((u) => u.id),
    ['a', 'b', 'c', 'd', 'e'],
  )
  assert.deepEqual(cut, ['f', 'g'])
  const agents = buildAgents(plan, 'r1', 'orch', models, 0)
  assert.equal(agents.length + 1, MAX_AGENTS, 'orchestrator + planned agents fills exactly the cap, no more')
})

test('caps: a unit that depends on a cut unit is cut too', () => {
  const raw: Plan = {
    summary: 's',
    units: [unit('a', 13), unit('b'), unit('c', 0, ['b'])] as Plan['units'],
  }
  const { plan, cut } = capPlan(raw, MAX_AGENTS)
  assert.deepEqual(
    plan.units.map((u) => u.id),
    ['a'],
  )
  assert.deepEqual(cut, ['b', 'c'])
})

test('selectReady returns queued agents whose deps are all done, in order', () => {
  const agents = [
    agent({ id: 'w1', status: 'done' }),
    agent({ id: 'w2', status: 'queued' }),
    agent({ id: 'lead', tier: 2, role: 'lead', deps: ['w1', 'w2'] }),
    agent({ id: 'after', deps: ['lead'] }),
    agent({ id: 'free' }),
    agent({ id: 'busy', status: 'running' }),
  ]
  assert.deepEqual(
    selectReady(agents).map((a) => a.id),
    ['w2', 'free'],
  )
})

test('selectReady holds a lead until every worker is done, including one paused on approval', () => {
  const agents = [
    agent({ id: 'w1', status: 'done' }),
    agent({ id: 'w2', status: 'waiting_approval' }),
    agent({ id: 'lead', tier: 2, role: 'lead', deps: ['w1', 'w2'] }),
  ]
  assert.deepEqual(selectReady(agents), [])
  agents[1].status = 'done'
  assert.deepEqual(
    selectReady(agents).map((a) => a.id),
    ['lead'],
  )
})

test('selectReady never picks the orchestrator and skips agents that are not queued', () => {
  const agents = [
    agent({ id: 'orch', role: 'orchestrator', tier: 1 }),
    agent({ id: 'x', status: 'failed' }),
    agent({ id: 'y', status: 'done' }),
  ]
  assert.deepEqual(selectReady(agents), [])
})

test('failAgent: attempts counts starts, so one retry then failed', () => {
  const a = agent({ id: 'x', status: 'running', startedAt: 5, attempts: 1 })
  failAgent(a, 'boom', 10)
  assert.equal(a.status, 'queued')
  assert.equal(a.startedAt, undefined)

  a.status = 'running'
  a.attempts = 2
  failAgent(a, 'boom again', 20)
  assert.equal(a.status, 'failed')
  assert.equal(a.error, 'boom again')
  assert.equal(a.endedAt, 20)
})

test('recoverStuck resets stale running agents through retry-or-fail, and leaves fresh ones alone', () => {
  const now = 10 * AGENT_STALL_MS
  const fresh = agent({ id: 'fresh', status: 'running', startedAt: now - 1000, attempts: 1 })
  const stale = agent({ id: 'stale', status: 'running', startedAt: now - AGENT_STALL_MS - 1, attempts: 1 })
  const doomed = agent({ id: 'doomed', status: 'running', startedAt: now - AGENT_STALL_MS - 1, attempts: 2 })
  const msgs = recoverStuck([fresh, stale, doomed], now)
  assert.equal(fresh.status, 'running')
  assert.equal(stale.status, 'queued')
  assert.equal(doomed.status, 'failed')
  assert.equal(msgs.length, 2)
})

test('blockFailed fails queued dependents of a failed agent, transitively', () => {
  const agents = [
    agent({ id: 'a', status: 'failed' }),
    agent({ id: 'b', deps: ['a'] }),
    agent({ id: 'c', deps: ['b'] }),
    agent({ id: 'd' }),
  ]
  blockFailed(agents, 1)
  assert.equal(agents[1].status, 'failed')
  assert.equal(agents[2].status, 'failed')
  assert.equal(agents[3].status, 'queued')
})

test('applyDecisions resumes only the agent that asked, feeds the decision into its brief, and refunds the attempt', () => {
  const run = runWith(
    [
      agent({ id: 'x', status: 'waiting_approval', approvalId: 'ap1', brief: 'deploy it', attempts: 1 }),
      agent({ id: 'y', status: 'waiting_approval', approvalId: 'ap2', brief: 'other', attempts: 1 }),
    ],
    [
      { id: 'ap1', runId: 'r1', agentId: 'x', kind: 'production_deploy', request: 'ship', status: 'pending', createdAt: 0 },
      { id: 'ap2', runId: 'r1', agentId: 'y', kind: 'budget_exceeded', request: 'more', status: 'pending', createdAt: 0 },
    ],
  )
  const msgs = applyDecisions(
    run,
    [{ id: 'd1', runId: 'r1', approvalId: 'ap1', decision: 'denied', note: 'not today', decidedAt: 5 }],
    5,
  )
  const x = run.agents.find((a) => a.id === 'x')!
  const y = run.agents.find((a) => a.id === 'y')!
  assert.equal(run.approvals[0].status, 'denied')
  assert.equal(run.approvals[0].note, 'not today')
  assert.equal(x.status, 'queued')
  assert.equal(x.attempts, 0)
  assert.match(x.brief, /hard stop 1.*DENIED/s)
  assert.match(x.brief, /Owner note: not today/)
  assert.equal(y.status, 'waiting_approval')
  assert.equal(run.approvals[1].status, 'pending')
  assert.equal(msgs.length, 1)
})

test('applyDecisions ignores decisions for unknown or already-decided approvals', () => {
  const run = runWith(
    [],
    [{ id: 'ap1', runId: 'r1', agentId: 'x', kind: 'budget_exceeded', request: 'q', status: 'approved', createdAt: 0 }],
  )
  applyDecisions(
    run,
    [
      { id: 'd1', runId: 'r1', approvalId: 'ap1', decision: 'denied', decidedAt: 1 },
      { id: 'd2', runId: 'r1', approvalId: 'nope', decision: 'approved', decidedAt: 1 },
    ],
    1,
  )
  assert.equal(run.approvals[0].status, 'approved')
})

test('parseApprovalInput maps the four hard-stop rule numbers and rejects everything else', () => {
  assert.deepEqual(parseApprovalInput({ rule: 1, request: ' deploy ' }), {
    kind: 'production_deploy',
    request: 'deploy',
  })
  assert.equal(parseApprovalInput({ rule: 2, request: 'drop table' })?.kind, 'destructive_op')
  assert.equal(parseApprovalInput({ rule: 3, request: 'new service' })?.kind, 'paid_or_secret')
  assert.equal(parseApprovalInput({ rule: 4, request: 'over budget' })?.kind, 'budget_exceeded')
  assert.equal(parseApprovalInput({ rule: 5, request: 'x' }), null)
  assert.equal(parseApprovalInput({ rule: 1, request: '   ' }), null)
  assert.equal(parseApprovalInput({ rule: '1', request: 'x' }), null)
  assert.equal(parseApprovalInput(null), null)
})
