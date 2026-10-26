// Upstash REST client for the runner. One POST per command: body is the argument array.
// Fetch is injected so tests never touch the network.
import { redact } from './redact'

export type Fetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface UpstashClient {
  command(args: (string | number)[]): Promise<unknown>
}

export class UpstashError extends Error {}

export function createUpstashClient(opts: { url: string; token: string; fetch?: Fetch }): UpstashClient {
  const fetchFn: Fetch = opts.fetch ?? ((url, init) => fetch(url, init))
  const secrets = [opts.token]
  return {
    async command(args) {
      const res = await fetchFn(opts.url.replace(/\/+$/, ''), {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      const text = await res.text()
      if (!res.ok) throw new UpstashError(redact(`upstash ${args[0]} failed (HTTP ${res.status}): ${text.slice(0, 200)}`, secrets))
      const body = JSON.parse(text) as { result?: unknown; error?: string }
      if (body.error) throw new UpstashError(redact(`upstash ${args[0]} error: ${body.error}`, secrets))
      return body.result
    },
  }
}

// Keys shared with the site. The backend owns the names; see lib/store.ts.
export const RUNNER_KEYS = {
  queue: 'runner:queue',
  heartbeat: 'runner:heartbeat',
  claim: (runId: string) => `runner:claim:${runId}`,
  events: (runId: string) => `run:${runId}:events`,
} as const

// Lua: delete the key only when it still holds our value. Same pattern the store uses for locks.
const RELEASE_IF_EQUALS = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end'

// Puts a run back on the queue, e.g. when shutdown stops it between steps, so no other runner misses it.
export async function requeueRun(client: UpstashClient, runId: string): Promise<void> {
  await client.command(['RPUSH', RUNNER_KEYS.queue, runId])
}

export async function popQueue(client: UpstashClient, max: number): Promise<string[]> {
  const result = await client.command(['LPOP', RUNNER_KEYS.queue, max])
  if (result === null || result === undefined) return []
  return Array.isArray(result) ? result.map(String) : [String(result)]
}

// SET NX EX: true when this runner now holds the claim on the run.
export async function claimRun(client: UpstashClient, runId: string, runnerId: string, ttlSec: number): Promise<boolean> {
  const r = await client.command(['SET', RUNNER_KEYS.claim(runId), runnerId, 'NX', 'EX', ttlSec])
  return r === 'OK'
}

export async function releaseClaim(client: UpstashClient, runId: string, runnerId: string): Promise<boolean> {
  const r = await client.command(['EVAL', RELEASE_IF_EQUALS, 1, RUNNER_KEYS.claim(runId), runnerId])
  return r === 1
}

export async function refreshClaim(client: UpstashClient, runId: string, runnerId: string, ttlSec: number): Promise<boolean> {
  const current = await client.command(['GET', RUNNER_KEYS.claim(runId)])
  if (current !== runnerId) return false
  await client.command(['EXPIRE', RUNNER_KEYS.claim(runId), ttlSec])
  return true
}

export async function writeHeartbeat(client: UpstashClient, payload: object, ttlSec: number): Promise<void> {
  await client.command(['SET', RUNNER_KEYS.heartbeat, JSON.stringify(payload), 'EX', ttlSec])
}

export async function clearHeartbeat(client: UpstashClient): Promise<void> {
  await client.command(['DEL', RUNNER_KEYS.heartbeat])
}

// Appends JSON lines to the run's event list. The site reads them with LRANGE.
export async function appendEvents(client: UpstashClient, runId: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return
  await client.command(['RPUSH', RUNNER_KEYS.events(runId), ...lines])
}
