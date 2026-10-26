import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoop } from '../scripts/lib/loop'

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

test('runLoop stops between steps when shouldStop turns true, without starting another step', async () => {
  let stop = false
  let calls = 0
  const result = await runLoop({
    step: async () => { calls += 1; stop = true; return { action: 'wave', more: true } },
    budgetMs: 1000,
    gapMs: 0,
    now: () => 0,
    sleep: async () => {},
    shouldStop: () => stop,
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { steps: 1, stoppedBy: 'stopped', lastAction: 'wave' })
})

test('runLoop does not start a step when shouldStop is already true', async () => {
  let calls = 0
  const result = await runLoop({
    step: async () => { calls += 1; return { action: 'wave', more: true } },
    budgetMs: 1000,
    gapMs: 0,
    shouldStop: () => true,
  })
  assert.equal(calls, 0)
  assert.equal(result.stoppedBy, 'stopped')
})
