// Heartbeat: a TTL key the site reads to show the runner is alive. A missing or stale key means down.
import { clearHeartbeat, writeHeartbeat, type UpstashClient } from './upstash'

export const HEARTBEAT_TTL_SEC = 45
export const HEARTBEAT_INTERVAL_MS = 15_000

export interface HeartbeatInfo {
  runnerId: string
  pid: number
  host: string
  startedAt: number
}

export interface HeartbeatOptions {
  client: UpstashClient
  info: HeartbeatInfo
  intervalMs?: number
  ttlSec?: number
  now?: () => number
  onError?: (err: unknown) => void
}

export interface Heartbeat {
  /** Stops the timer, waits for an in-flight write, then deletes the key. */
  stop(): Promise<void>
}

export function startHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const ttlSec = opts.ttlSec ?? HEARTBEAT_TTL_SEC
  const now = opts.now ?? Date.now
  let inFlight: Promise<void> = Promise.resolve()
  let stopped = false

  const beat = () => {
    if (stopped) return
    const payload = { ...opts.info, ts: now() }
    inFlight = inFlight
      .then(() => writeHeartbeat(opts.client, payload, ttlSec))
      .catch((err: unknown) => opts.onError?.(err))
  }

  beat()
  const timer = setInterval(beat, opts.intervalMs ?? HEARTBEAT_INTERVAL_MS)
  timer.unref?.()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      await inFlight
      await clearHeartbeat(opts.client).catch((err: unknown) => opts.onError?.(err))
    },
  }
}
