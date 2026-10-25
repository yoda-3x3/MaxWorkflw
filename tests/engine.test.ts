import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBackend, createRunStore } from '../lib/store'
import { createMockLlm, type MockCall, type MockHandler } from '../lib/llm'
import { branchForRun } from '../lib/github'
import {
  LOCK_TTL_SEC,
  createRun,
  runStep,
  step,
  type EngineDeps,
  type EngineGitHub,
  type EngineStore,
  type EngineWorkspace,
} from '../lib/engine'
import { AGENT_STALL_MS, RUN_DEADLINE_MS, type ApprovalDecision, type Run } from '../lib/types'

// Everything here is mocked. The store is the real one on the in-memory backend,
// the model is the mock Llm, and GitHub only opens PRs. Agents never touch files
// here: a fake workspace records the commits the engine asks for.

const models = { orchestrator: 'opus-test', lead: 'sonnet-test', worker: 'haiku-test' }

const isPlanner = (c: MockCall) => c.kind === 'complete' && (c.req.system ?? '').startsWith('You are the Orchestrator of MaxWorkflw')
const isFinal = (c: MockCall) => c.kind === 'complete' && (c.req.system ?? '').startsWith('You are the Orchestrator writing the final report')
const isLead = (c: MockCall) => c.kind === 'work' && (c.req.system ?? '').startsWith('You are a lead in MaxWorkflw')
const promptOf = (c: MockCall) => c.req.prompt
const planReply = (units: unknown[]) => ({ text: JSON.stringify({ summary: 'plan summary', units }) })
const approvalFor = (rule: 1 | 2 | 3 | 4, request: string) => ({ text: '', approval: { rule, request } })

function fakeGithub() {
  const prs: { runId: string; title: string; body: string }[] = []
  const github = (_repo: string) => ({
    async openPR(runId: string, args: { title: string; body: string }) {
      prs.push({ runId, ...args })
      return { number: 7, url: 'https://github.test/o/r/pull/7', state: 'open' }
    },
  }) as unknown as EngineGitHub
  return { github, prs }
}

function setup(handler: MockHandler) {
  const store = createRunStore(createMemoryBackend())
  const llm = createMockLlm(handler)
  const gh = fakeGithub()
  let t = 1_000
  const deps: Partial<EngineDeps> = { llm, store, github: gh.github, models, now: () => t }
  return {
    store,
    llm,
    gh,
    deps,
    setNow(v: number) {
      t = v
    },
    async current(id: string): Promise<Run> {
      return (await store.getRunForEngine(id))!
    },
  }
}

// A workspace that records commits. commit() can be scripted to return false or throw.
function fakeWorkspace(commit: (message: string) => Promise<boolean> = async () => true) {
  const commits: string[] = []
  const ws: EngineWorkspace = {
    dir: '/work/repo',
    async commit(message) {
      commits.push(message)
      return commit(message)
    },
  }
  return { ws, commits }
}

async function drain(id: string, deps: Partial<EngineDeps>, max = 20): Promise<string[]> {
  const actions: string[] = []
  for (let i = 0; i < max; i++) {
    const r = await step(id, deps)
    actions.push(r.action)
    if (!r.more) break
  }
  return actions
}

const FULL_UNITS = [
  {
    id: 'A',
    title: 'Lead A',
    brief: 'lead A integrates',
    deps: [],
    workers: [
      { id: 'w1', title: 'W1', brief: 'do w1', deps: [] },
      { id: 'w2', title: 'W2', brief: 'do w2', deps: [] },
    ],
  },
  { id: 'B', title: 'B', brief: 'do b', deps: ['A'] },
  { id: 'C', title: 'C', brief: 'do c', deps: [] },
]

test('createRun builds a queued run, saves it, and returns it', async () => {
  const env = setup(() => ({ text: 'x' }))
  const run = await createRun({ ownerId: 'me', task: 'ship it', repo: 'o/r' }, env.deps)
  assert.equal(run.status, 'queued')
  assert.equal(run.ownerId, 'me')
  assert.equal(run.deadlineAt, run.createdAt + RUN_DEADLINE_MS)
  assert.equal(run.agents[0].role, 'orchestrator')
  const saved = await env.store.getRun('me', run.id)
  assert.equal(saved?.id, run.id)
})

test('full run: plan, parallel wave, lead integration, dependent unit, final report', async () => {
  const leadPrompts: string[] = []
  const env = setup((c) => {
    if (isPlanner(c)) return planReply(FULL_UNITS)
    if (isFinal(c)) return { text: 'FINAL REPORT: all good' }
    const brief = promptOf(c)
    if (isLead(c)) leadPrompts.push(brief)
    const marker = brief.match(/CONTEXT: (lead A integrates|do w\d|do [bc])/)?.[1] ?? 'unknown'
    return { text: `STATUS: done for ${marker}` }
  })
  const run = await createRun({ ownerId: 'me', task: 'ship it' }, env.deps)

  const actions = await drain(run.id, env.deps)
  assert.deepEqual(actions, ['planned', 'wave', 'wave', 'wave', 'finalized'])

  const done = await env.current(run.id)
  assert.equal(done.status, 'done')
  assert.equal(done.finalReport, 'FINAL REPORT: all good')
  assert.ok(done.tokens > 0)
  assert.equal(done.agents.length, 6, 'orchestrator + lead A + W1 + W2 + B + C')
  assert.ok(done.agents.every((a) => a.status === 'done'))

  // The lead integrated its workers' reports.
  assert.equal(leadPrompts.length, 1)
  assert.match(leadPrompts[0], /WORKER REPORTS:/)
  assert.match(leadPrompts[0], /STATUS: done for do w1/)
  assert.match(leadPrompts[0], /STATUS: done for do w2/)

  // Wave 2 ran both workers and the standalone unit C together: haiku, haiku, sonnet.
  const agentCalls = env.llm.calls.filter((c) => c.kind === 'work')
  assert.deepEqual(
    agentCalls.slice(0, 3).map((c) => c.req.model),
    [models.worker, models.worker, models.lead],
  )
})

test('over-budget plan is truncated to the agent cap and the cut is logged', async () => {
  const big = (id: string) => ({
    id,
    title: id,
    brief: `brief ${id}`,
    deps: [],
    workers: Array.from({ length: 6 }, (_, i) => ({ id: `${id}-${i}`, title: `${id}${i}`, brief: 'w', deps: [] })),
  })
  const env = setup((c) => (isPlanner(c) ? planReply([big('a'), big('b'), big('c')]) : { text: 'x' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  assert.equal((await step(run.id, env.deps)).action, 'planned')

  const after = await env.current(run.id)
  assert.equal(after.agents.length, 15, 'orchestrator + 14 planned agents, never more')
  assert.ok(after.events.some((e) => e.message === 'cut by agent limit: unit c'))
  assert.ok(!after.plan!.units.some((u) => u.id === 'c'))
})

test('planner reply that fails validation is retried once, then the run proceeds', async () => {
  let plans = 0
  const env = setup((c) => {
    if (isPlanner(c)) {
      plans++
      return plans === 1 ? { text: 'sorry, no JSON today' } : planReply([{ id: 'x', title: 'X', brief: 'do x', deps: [] }])
    }
    return { text: 'STATUS: done' }
  })
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  const actions = await drain(run.id, env.deps)
  assert.deepEqual(actions, ['replan', 'planned', 'wave', 'finalized'])
  assert.equal((await env.current(run.id)).status, 'done')
})

test('planner failing twice fails the run with a clear message', async () => {
  const env = setup(() => ({ text: 'still no JSON' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  const actions = await drain(run.id, env.deps)
  assert.deepEqual(actions, ['replan', 'failed'])
  const r = await env.current(run.id)
  assert.equal(r.status, 'failed')
  assert.match(r.error ?? '', /planner failed/)
})

test('approval pauses only the asking agent; an approved decision resumes it', async () => {
  const env = setup((c) => {
    if (isPlanner(c)) {
      return planReply([
        { id: 'x', title: 'X', brief: 'do x', deps: [] },
        { id: 'y', title: 'Y', brief: 'do y', deps: [] },
      ])
    }
    if (isFinal(c)) return { text: 'final' }
    const brief = promptOf(c)
    if (brief.includes('CONTEXT: do x') && !brief.includes('APPROVAL DECISION')) {
      return approvalFor(1, 'ship to prod?')
    }
    return { text: brief.includes('CONTEXT: do x') ? 'x deployed' : 'y done' }
  })
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)

  assert.equal((await step(run.id, env.deps)).action, 'planned')
  assert.equal((await step(run.id, env.deps)).action, 'wave')

  // Y finished in the same wave X paused. Nothing else can run, so the run waits.
  let mid = await env.current(run.id)
  assert.equal(mid.agents.find((a) => a.title === 'X')!.status, 'waiting_approval')
  assert.equal(mid.agents.find((a) => a.title === 'Y')!.status, 'done')
  assert.deepEqual(await step(run.id, env.deps), { runId: run.id, action: 'waiting', more: false })
  mid = await env.current(run.id)
  assert.equal(mid.status, 'waiting_approval')
  assert.equal(mid.approvals.length, 1)
  assert.equal(mid.approvals[0].status, 'pending')
  assert.equal(mid.approvals[0].kind, 'production_deploy')

  // The owner's decision goes through the store queue. The next step drains it and resumes X only.
  const yCallsBefore = env.llm.calls.filter((c) => promptOf(c).includes('CONTEXT: do y')).length
  const decision: ApprovalDecision = {
    id: 'd1',
    runId: run.id,
    approvalId: mid.approvals[0].id,
    decision: 'approved',
    decidedAt: 2_000,
  }
  await env.store.enqueueDecision(run.id, decision)
  assert.deepEqual(await drain(run.id, env.deps), ['wave', 'finalized'])
  assert.equal(env.llm.calls.filter((c) => promptOf(c).includes('CONTEXT: do y')).length, yCallsBefore)

  const end = await env.current(run.id)
  assert.equal(end.approvals[0].status, 'approved')
  const x = end.agents.find((a) => a.title === 'X')!
  assert.equal(x.status, 'done')
  assert.match(x.brief, /APPROVAL DECISION for hard stop 1.*APPROVED/s)
  assert.equal(end.status, 'done')
})

test('a denied approval resumes the agent with a do-not-act instruction', async () => {
  const env = setup((c) => {
    if (isPlanner(c)) return planReply([{ id: 'x', title: 'X', brief: 'do x', deps: [] }])
    if (isFinal(c)) return { text: 'final' }
    if (!promptOf(c).includes('APPROVAL DECISION')) return approvalFor(4, 'spend more')
    return { text: 'STATUS: blocked, approval denied' }
  })
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  await step(run.id, env.deps)
  await step(run.id, env.deps)
  assert.equal((await step(run.id, env.deps)).action, 'waiting')

  await env.store.enqueueDecision(run.id, {
    id: 'd1',
    runId: run.id,
    approvalId: (await env.current(run.id)).approvals[0].id,
    decision: 'denied',
    note: 'no',
    decidedAt: 2_000,
  })
  await drain(run.id, env.deps)
  const x = (await env.current(run.id)).agents.find((a) => a.title === 'X')!
  assert.equal(x.status, 'done')
  assert.match(x.brief, /hard stop 4.*DENIED/s)
  assert.match(x.brief, /Owner note: no/)
  assert.match(x.brief, /Do not take that step/)
})

test('a failing agent gets one retry, then fails; its dependents are blocked and the run still finishes', async () => {
  let fCalls = 0
  const env = setup((c) => {
    if (isPlanner(c)) {
      return planReply([
        { id: 'f', title: 'F', brief: 'do f', deps: [] },
        { id: 'g', title: 'G', brief: 'do g', deps: ['f'] },
        { id: 'h', title: 'H', brief: 'do h', deps: [] },
      ])
    }
    if (isFinal(c)) {
      assert.match(promptOf(c), /FAILED: model overloaded/)
      return { text: 'final with failures' }
    }
    if (promptOf(c).includes('CONTEXT: do f')) {
      fCalls++
      throw new Error('model overloaded')
    }
    return { text: 'STATUS: done' }
  })
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)

  const actions = await drain(run.id, env.deps)
  assert.deepEqual(actions, ['planned', 'wave', 'wave', 'finalized'])
  assert.equal(fCalls, 2, 'one attempt, one retry, then failed')

  const end = await env.current(run.id)
  assert.equal(end.status, 'done')
  assert.equal(end.finalReport, 'final with failures')
  const byTitle = (t: string) => end.agents.find((a) => a.title === t)!
  assert.equal(byTitle('F').status, 'failed')
  assert.equal(byTitle('F').attempts, 2)
  assert.equal(byTitle('G').status, 'failed')
  assert.match(byTitle('G').error ?? '', /blocked by failed dependency/)
  assert.equal(byTitle('H').status, 'done')
})

test('a run past its 24h deadline fails with a clear message', async () => {
  const env = setup(() => ({ text: 'x' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  env.setNow(run.deadlineAt + 1)
  const r = await step(run.id, env.deps)
  assert.equal(r.action, 'failed')
  const end = await env.current(run.id)
  assert.equal(end.status, 'failed')
  assert.match(end.error ?? '', /24 hours/)
})

test('a held lock makes the step a no-op', async () => {
  const env = setup(() => ({ text: 'x' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  assert.ok(await env.store.acquireRunLock(run.id))
  assert.deepEqual(await step(run.id, env.deps), { runId: run.id, action: 'locked', more: false })
  assert.equal(env.llm.calls.length, 0)
})

test('the lock is released after a step, even when the step throws', async () => {
  const env = setup(() => ({ text: 'x' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  // Planner errors are caught inside the step. A store failure is not, so it escapes.
  const failingStore: EngineStore = Object.assign(Object.create(env.store), {
    saveRun: async () => {
      throw new Error('db down')
    },
  })
  await assert.rejects(step(run.id, { ...env.deps, store: failingStore }), /db down/)
  assert.ok(await env.store.acquireRunLock(run.id), 'lock must be free again')
})

test('a step with no Llm configured fails before it touches the run', async () => {
  const env = setup(() => ({ text: 'x' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  await assert.rejects(step(run.id, { store: env.store, models, now: () => 1 }), /no Llm/)
  assert.ok(await env.store.acquireRunLock(run.id), 'lock was never taken')
})

test('an agent stuck in running past the timeout is reset and runs again', async () => {
  const env = setup((c) => {
    if (isPlanner(c)) return planReply([{ id: 'x', title: 'X', brief: 'do x', deps: [] }])
    if (isFinal(c)) return { text: 'final' }
    return { text: 'STATUS: done' }
  })
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  assert.equal((await step(run.id, env.deps)).action, 'planned')

  // Simulate a dead invocation that left X running with one attempt used.
  const stuck = await env.current(run.id)
  const x = stuck.agents.find((a) => a.title === 'X')!
  x.status = 'running'
  x.startedAt = 1_000
  x.attempts = 1
  await env.store.saveRun(stuck)
  env.setNow(1_000 + AGENT_STALL_MS + 1)

  assert.equal((await step(run.id, env.deps)).action, 'wave')
  const after = (await env.current(run.id)).agents.find((a) => a.title === 'X')!
  assert.equal(after.status, 'done')
  assert.equal(after.attempts, 2)
})

test('repo run: agents work in the checkout, each agent is committed, and a PR opens on the run branch', async () => {
  const { ws, commits } = fakeWorkspace()
  const env = setup((c) => {
    if (isPlanner(c)) return planReply([{ id: 'w', title: 'W', brief: 'do w', deps: [] }])
    if (isFinal(c)) return { text: 'final' }
    return { text: 'STATUS: done\nCHANGED: src/a.ts' }
  })
  const run = await createRun({ ownerId: 'me', task: 't', repo: 'o/r' }, env.deps)
  await drain(run.id, { ...env.deps, workspace: ws })

  const workCalls = env.llm.calls.filter((c) => c.kind === 'work')
  assert.ok(workCalls.length > 0)
  assert.ok(workCalls.every((c) => c.kind === 'work' && c.req.cwd === '/work/repo'), 'agents run in the checkout')
  assert.deepEqual(commits, ['workflwpro: a1 W'])

  const end = await env.current(run.id)
  assert.equal(end.status, 'done')
  assert.equal(end.branch, branchForRun(run.id))
  assert.equal(end.prUrl, 'https://github.test/o/r/pull/7')
  assert.equal(end.prNumber, 7)
  assert.equal(env.gh.prs.length, 1)
  assert.equal(env.gh.prs[0].runId, run.id)
})

test('a repo run where nothing was committed opens no PR', async () => {
  const { ws } = fakeWorkspace(async () => false)
  const env = setup((c) => {
    if (isPlanner(c)) return planReply([{ id: 'w', title: 'W', brief: 'do w', deps: [] }])
    if (isFinal(c)) return { text: 'final' }
    return { text: 'STATUS: done, nothing to change' }
  })
  const run = await createRun({ ownerId: 'me', task: 't', repo: 'o/r' }, env.deps)
  await drain(run.id, { ...env.deps, workspace: ws })
  assert.equal(env.gh.prs.length, 0)
  const end = await env.current(run.id)
  assert.equal(end.prUrl, undefined)
  assert.equal(end.branch, undefined)
})

test('a commit that throws fails that attempt, and the retry commits the work', async () => {
  let fail = true
  const { ws, commits } = fakeWorkspace(async () => {
    if (fail) {
      fail = false
      throw new Error('push rejected')
    }
    return true
  })
  const env = setup((c) => {
    if (isPlanner(c)) return planReply([{ id: 'x', title: 'X', brief: 'do x', deps: [] }])
    if (isFinal(c)) return { text: 'final' }
    return { text: 'STATUS: done' }
  })
  const run = await createRun({ ownerId: 'me', task: 't', repo: 'o/r' }, env.deps)
  const actions = await drain(run.id, { ...env.deps, workspace: ws })
  assert.deepEqual(actions, ['planned', 'wave', 'wave', 'finalized'])
  assert.equal(commits.length, 2)

  const x = (await env.current(run.id)).agents.find((a) => a.title === 'X')!
  assert.equal(x.status, 'done')
  assert.equal(x.attempts, 2)
  assert.equal(env.gh.prs.length, 1)
})

test('runStep returns only the more flag', async () => {
  const env = setup((c) => (isPlanner(c) ? planReply([{ id: 'x', title: 'X', brief: 'do x', deps: [] }]) : { text: 'ok' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  assert.deepEqual(await runStep(run.id, env.deps), { more: true })
})

test('a save that fails after the plan is attached rolls back, so the retry plans once with no duplicate agents', async () => {
  const env = setup((c) => (isPlanner(c) ? planReply([{ id: 'x', title: 'X', brief: 'do x', deps: [] }]) : { text: 'ok' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)

  let failOnce = true
  const flaky: EngineStore = Object.assign(Object.create(env.store), {
    saveRun: async (r: Run) => {
      if (failOnce && r.plan) {
        failOnce = false
        throw new Error('save hiccup')
      }
      return env.store.saveRun(r)
    },
  })
  assert.equal((await step(run.id, { ...env.deps, store: flaky })).action, 'replan')
  const rolledBack = await env.current(run.id)
  assert.equal(rolledBack.plan, undefined)
  assert.equal(rolledBack.agents.length, 1, 'only the orchestrator remains')
  assert.equal(rolledBack.agents[0].status, 'queued', 'orchestrator is retryable, not done')

  assert.equal((await step(run.id, env.deps)).action, 'planned')
  const planned = await env.current(run.id)
  assert.equal(planned.agents.length, 2, 'orchestrator + X, no duplicates')
})

test('decisions drained by a failing step go back on the queue, so the next step still applies them', async () => {
  const env = setup((c) => {
    if (isPlanner(c)) return planReply([{ id: 'x', title: 'X', brief: 'do x', deps: [] }])
    if (isFinal(c)) return { text: 'final' }
    if (!promptOf(c).includes('APPROVAL DECISION')) return approvalFor(1, 'ship to prod?')
    return { text: 'x deployed' }
  })
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  await step(run.id, env.deps)
  await step(run.id, env.deps)
  assert.equal((await step(run.id, env.deps)).action, 'waiting')
  const approvalId = (await env.current(run.id)).approvals[0].id
  await env.store.enqueueDecision(run.id, { id: 'd1', runId: run.id, approvalId, decision: 'approved', decidedAt: 2_000 })

  // The step drains the decision, then the save fails. The decision must not be lost.
  const failingStore: EngineStore = Object.assign(Object.create(env.store), {
    saveRun: async () => {
      throw new Error('db down')
    },
  })
  await assert.rejects(step(run.id, { ...env.deps, store: failingStore }), /db down/)
  const requeued = await env.store.drainDecisions(run.id)
  assert.deepEqual(requeued.map((d) => d.id), ['d1'])
  await env.store.enqueueDecision(run.id, requeued[0])

  assert.deepEqual(await drain(run.id, env.deps), ['wave', 'finalized'])
  const end = await env.current(run.id)
  assert.equal(end.approvals[0].status, 'approved')
  assert.equal(end.status, 'done')
})

test('the run lock outlives the longest step', async () => {
  const env = setup(() => ({ text: 'x' }))
  const run = await createRun({ ownerId: 'me', task: 't' }, env.deps)
  const ttls: number[] = []
  const spying: EngineStore = Object.assign(Object.create(env.store), {
    acquireRunLock: async (id: string, ttl?: number) => {
      ttls.push(ttl ?? 0)
      return env.store.acquireRunLock(id, ttl)
    },
  })
  await step(run.id, { ...env.deps, store: spying })
  // One model call is capped at 30 min; a step is at most one parallel wave of those.
  assert.ok(LOCK_TTL_SEC >= 2 * 30 * 60, `lock ttl ${LOCK_TTL_SEC}s is shorter than a step`)
  assert.deepEqual(ttls, [LOCK_TTL_SEC])
})
