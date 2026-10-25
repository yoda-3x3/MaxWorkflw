import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoop } from '../scripts/lib/loop'
import { missingEnv, validRunId } from '../scripts/lib/env'

test('runLoop stops as soon as the engine says no more steps', async () => {
  const actions = [{ action: 'planned', more: true }, { action: 'waiting', more: false }]
  const sleeps: number[] = []
  const result = await runLoop({
    step: async () => actions.shift()!,
    budgetMs: 10_000,
    gapMs: 5,
    now: () => 0,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.deepEqual(result, { steps: 2, stoppedBy: 'idle', lastAction: 'waiting' })
  assert.deepEqual(sleeps, [5])
})

test('runLoop stops with budget when time runs out while more work remains', async () => {
  let t = 0
  let calls = 0
  const result = await runLoop({
    step: async () => { calls += 1; t += 400; return { action: 'wave', more: true } },
    budgetMs: 1000,
    gapMs: 0,
    now: () => t,
    sleep: async () => {},
  })
  assert.equal(result.stoppedBy, 'budget')
  assert.equal(calls, 3)
  assert.equal(result.steps, 3)
})

test('runLoop logs each step and does not sleep after the last one', async () => {
  const lines: string[] = []
  const sleeps: number[] = []
  await runLoop({
    step: async () => ({ action: 'finalized', more: false }),
    budgetMs: 1000,
    gapMs: 9,
    now: () => 0,
    sleep: async (ms) => { sleeps.push(ms) },
    log: (l) => lines.push(l),
  })
  assert.deepEqual(lines, ['step 1: finalized (stop)'])
  assert.deepEqual(sleeps, [])
})

test('missingEnv names missing variables and never values', () => {
  const env = { RUN_ID: 'r1', CLAUDE_CODE_OAUTH_TOKEN: 'secret-value', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: 'x', GH_REPO_TOKEN: undefined }
  assert.deepEqual(missingEnv(env), ['UPSTASH_REDIS_REST_URL', 'GH_REPO_TOKEN'])
  assert.deepEqual(missingEnv({ RUN_ID: 'r', CLAUDE_CODE_OAUTH_TOKEN: 'a', UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't', GH_REPO_TOKEN: 'g' }), [])
})

test('validRunId accepts the store id charset only', () => {
  assert.equal(validRunId('abc-DEF_1'), true)
  for (const bad of [undefined, '', 'a/b', 'a b', 'a'.repeat(129), '$(x)']) {
    assert.equal(validRunId(bad), false, String(bad))
  }
})
