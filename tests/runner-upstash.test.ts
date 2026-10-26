import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendEvents,
  claimRun,
  clearHeartbeat,
  createUpstashClient,
  popQueue,
  refreshClaim,
  requeueRun,
  releaseClaim,
  RUNNER_KEYS,
  UpstashError,
  writeHeartbeat,
  type Fetch,
} from '../scripts/lib/upstash'
import { startHeartbeat } from '../scripts/lib/heartbeat'
import { createEventBatcher } from '../scripts/lib/events'

// Fake Upstash: records each command body and answers from a queue of replies.
function fakeFetch(replies: Array<{ status?: number; body: unknown }>) {
  const calls: { url: string; auth: string; args: unknown[] }[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, args: JSON.parse(init.body) })
    const r = replies.shift() ?? { body: { result: null } }
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, text: async () => JSON.stringify(r.body) }
  }
  return { fetch, calls }
}

test('createUpstashClient posts the argument array with a bearer token and returns result', async () => {
  const { fetch, calls } = fakeFetch([{ body: { result: 'OK' } }])
  const client = createUpstashClient({ url: 'https://db.upstash.io/', token: 'tok', fetch })
  assert.equal(await client.command(['PING']), 'OK')
  assert.equal(calls[0].url, 'https://db.upstash.io')
  assert.equal(calls[0].auth, 'Bearer tok')
  assert.deepEqual(calls[0].args, ['PING'])
})

test('createUpstashClient throws with the token redacted from HTTP and command errors', async () => {
  const { fetch } = fakeFetch([{ status: 401, body: { error: 'bad token tok-secret-value' } }])
  const client = createUpstashClient({ url: 'https://x', token: 'tok-secret-value', fetch })
  await assert.rejects(client.command(['GET', 'k']), (err: unknown) => {
    assert.ok(err instanceof UpstashError)
    assert.ok(!String(err.message).includes('tok-secret-value'))
    return true
  })
  const second = fakeFetch([{ body: { error: 'ERR wrong type' } }])
  const c2 = createUpstashClient({ url: 'https://x', token: 'tok-secret-value', fetch: second.fetch })
  await assert.rejects(c2.command(['LPOP', 'k']), /ERR wrong type/)
})

test('popQueue takes up to max run ids from runner:queue', async () => {
  const { fetch, calls } = fakeFetch([{ body: { result: ['r1'] } }, { body: { result: null } }])
  const client = createUpstashClient({ url: 'https://x', token: 't', fetch })
  assert.deepEqual(await popQueue(client, 1), ['r1'])
  assert.deepEqual(calls[0].args, ['LPOP', RUNNER_KEYS.queue, 1])
  assert.deepEqual(await popQueue(client, 1), [])
})

test('claimRun is SET NX EX and reports whether this runner won', async () => {
  const { fetch, calls } = fakeFetch([{ body: { result: 'OK' } }, { body: { result: null } }])
  const client = createUpstashClient({ url: 'https://x', token: 't', fetch })
  assert.equal(await claimRun(client, 'run-1', 'pc-1', 120), true)
  assert.deepEqual(calls[0].args, ['SET', 'runner:claim:run-1', 'pc-1', 'NX', 'EX', 120])
  assert.equal(await claimRun(client, 'run-1', 'pc-2', 120), false)
})

test('releaseClaim runs the compare-and-delete script for this runner only', async () => {
  const { fetch, calls } = fakeFetch([{ body: { result: 1 } }])
  const client = createUpstashClient({ url: 'https://x', token: 't', fetch })
  assert.equal(await releaseClaim(client, 'run-1', 'pc-1'), true)
  const [cmd, script, n, key, value] = calls[0].args as unknown[]
  assert.equal(cmd, 'EVAL')
  assert.match(String(script), /GET.*ARGV\[1\]/)
  assert.deepEqual([n, key, value], [1, 'runner:claim:run-1', 'pc-1'])
})

test('refreshClaim extends the TTL only while this runner still holds the claim', async () => {
  const held = fakeFetch([{ body: { result: 'pc-1' } }, { body: { result: 1 } }])
  const c1 = createUpstashClient({ url: 'https://x', token: 't', fetch: held.fetch })
  assert.equal(await refreshClaim(c1, 'run-1', 'pc-1', 120), true)
  assert.deepEqual(held.calls[1].args, ['EXPIRE', 'runner:claim:run-1', 120])

  const lost = fakeFetch([{ body: { result: 'pc-2' } }])
  const c2 = createUpstashClient({ url: 'https://x', token: 't', fetch: lost.fetch })
  assert.equal(await refreshClaim(c2, 'run-1', 'pc-1', 120), false)
  assert.equal(lost.calls.length, 1)
})

test('heartbeat and events use the agreed keys and TTL', async () => {
  const { fetch, calls } = fakeFetch([{ body: { result: 'OK' } }, { body: { result: 1 } }, { body: { result: 2 } }])
  const client = createUpstashClient({ url: 'https://x', token: 't', fetch })
  await writeHeartbeat(client, { runnerId: 'pc-1', ts: 5 }, 45)
  await clearHeartbeat(client)
  await appendEvents(client, 'run-1', ['{"a":1}', '{"a":2}'])
  assert.deepEqual(calls[0].args, ['SET', 'runner:heartbeat', '{"runnerId":"pc-1","ts":5}', 'EX', 45])
  assert.deepEqual(calls[1].args, ['DEL', 'runner:heartbeat'])
  assert.deepEqual(calls[2].args, ['RPUSH', 'run:run-1:events', '{"a":1}', '{"a":2}'])
})

test('appendEvents with no lines makes no request', async () => {
  const { fetch, calls } = fakeFetch([])
  await appendEvents(createUpstashClient({ url: 'https://x', token: 't', fetch }), 'run-1', [])
  assert.equal(calls.length, 0)
})

test('startHeartbeat writes immediately, refreshes on each tick, and clears the key on stop', async () => {
  const writes: unknown[][] = []
  const client = createUpstashClient({ url: 'https://x', token: 't', fetch: async (_url, init) => {
    writes.push(JSON.parse(init.body))
    return { ok: true, status: 200, text: async () => '{"result":"OK"}' }
  } })
  const hb = startHeartbeat({
    client,
    info: { runnerId: 'pc-1', pid: 1, host: 'h', startedAt: 0 },
    intervalMs: 1_000_000,
    now: () => 42,
  })
  await hb.stop()
  assert.equal(writes[0][0], 'SET')
  assert.equal(writes[0][3], 'EX')
  assert.equal(writes[0][4], 45)
  assert.deepEqual(JSON.parse(String(writes[0][2])), { runnerId: 'pc-1', pid: 1, host: 'h', startedAt: 0, ts: 42 })
  assert.deepEqual(writes[writes.length - 1], ['DEL', 'runner:heartbeat'])
})

test('createEventBatcher flushes on size, keeps order, and writes the rest on close', async () => {
  const batches: string[][] = []
  const b = createEventBatcher({
    write: async (lines) => { batches.push(lines) },
    maxItems: 2,
    flushMs: 1_000_000,
  })
  b.push({ n: 1 })
  b.push({ n: 2 })
  b.push({ n: 3 })
  await b.close()
  assert.deepEqual(batches, [['{"n":1}', '{"n":2}'], ['{"n":3}']])
  assert.equal(b.pending(), 0)
})

test('createEventBatcher keeps lines after a failed write and retries them', async () => {
  let fail = true
  const written: string[][] = []
  const errors: unknown[] = []
  const b = createEventBatcher({
    write: async (lines) => {
      if (fail) throw new Error('upstash down')
      written.push(lines)
    },
    onError: (e) => errors.push(e),
    flushMs: 1_000_000,
  })
  b.push({ n: 1 })
  await b.flush()
  assert.equal(errors.length, 1)
  assert.equal(b.pending(), 1)
  fail = false
  await b.close()
  assert.deepEqual(written, [['{"n":1}']])
})

test('requeueRun pushes the run id back onto runner:queue', async () => {
  const { fetch, calls } = fakeFetch([{ body: { result: 1 } }])
  await requeueRun(createUpstashClient({ url: 'https://x', token: 't', fetch }), 'run-9')
  assert.deepEqual(calls[0].args, ['RPUSH', 'runner:queue', 'run-9'])
})
