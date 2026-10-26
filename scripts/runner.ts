// Long-running runner on this PC. Polls the Upstash queue for runs, claims one, drives the engine
// with the Claude Agent SDK (subscription billing), and keeps a heartbeat so the site can show it is up.
// Start with `npm run runner`. Install as a logon task with scripts/install-runner-task.ps1.
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { step } from '../lib/engine'
import { createGitHubClient } from '../lib/github'
import { resolveModels } from '../lib/llm'
import { getRunStore } from '../lib/store'
import { createSdkLlm } from './lib/sdk-llm'
import { ENV_FILES, mergeEnv, missingEnv, parseEnvText, stripApiKey, validRunId, REQUIRED_ENV } from './lib/env'
import { execGit, parseRepo, prepareWorkspace, type Workspace } from './lib/git'
import { readGhToken } from './lib/gh'
import { redact } from './lib/redact'
import { runLoop } from './lib/loop'
import { createEventBatcher } from './lib/events'
import { HEARTBEAT_INTERVAL_MS, startHeartbeat, type Heartbeat } from './lib/heartbeat'
import {
  appendEvents,
  claimRun,
  createUpstashClient,
  popQueue,
  refreshClaim,
  requeueRun,
  releaseClaim,
  type UpstashClient,
} from './lib/upstash'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IDLE_POLL_MS = 15_000
const ACTIVE_POLL_MS = 2_000
const STEP_GAP_MS = 2_000
const CLAIM_TTL_SEC = 120
const CLAIM_REFRESH_MS = 30_000
const SHUTDOWN_GRACE_MS = 3_000

const secrets: string[] = []
let stopping = false
let activeRunId: string | null = null
let client: UpstashClient | undefined
let runnerId = ''
const wakers = new Set<() => void>()

function log(line: string) {
  console.log(`${new Date().toISOString()} ${redact(line, secrets)}`)
}

// Sleeps for `ms`, or until a shutdown signal wakes it.
function pause(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const done = () => {
      clearTimeout(timer)
      wakers.delete(done)
      resolveSleep()
    }
    const timer = setTimeout(done, ms)
    wakers.add(done)
  })
}

// Loads scripts/.env and runner.env into process.env. Process env wins over both files.
function loadEnv(): void {
  let fileValues: Record<string, string> = {}
  for (const rel of [...ENV_FILES].reverse()) {
    try {
      fileValues = { ...fileValues, ...parseEnvText(readFileSync(resolve(REPO_DIR, rel), 'utf8')) }
    } catch {
      // A missing file is fine: process env may carry everything.
    }
  }
  const merged = mergeEnv(fileValues, process.env)
  const { removed } = stripApiKey(merged)
  if (removed) log('ignored ANTHROPIC_API_KEY; using CLAUDE_CODE_OAUTH_TOKEN (subscription)')
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) process.env[k] = v
  }
  delete process.env.ANTHROPIC_API_KEY
}

async function processRun(runId: string, c: UpstashClient, models: ReturnType<typeof resolveModels>): Promise<void> {
  const store = getRunStore()
  const run = await store.getRunForEngine(runId)
  if (!run) {
    log(`run ${runId} not found`)
    return
  }

  const batcher = createEventBatcher({
    write: (lines) => appendEvents(c, runId, lines),
    onError: (err) => log(`event write failed: ${err instanceof Error ? err.message : String(err)}`),
  })
  const refresh = setInterval(() => {
    refreshClaim(c, runId, runnerId, CLAIM_TTL_SEC).catch((err: unknown) =>
      log(`claim refresh failed: ${err instanceof Error ? err.message : String(err)}`))
  }, CLAIM_REFRESH_MS)
  refresh.unref?.()

  let workspace: Workspace | undefined
  try {
    const token = run.repo ? await readGhToken() : undefined
    if (token) secrets.push(token)
    if (run.repo) {
      workspace = await prepareWorkspace({ repo: run.repo, runId, exec: execGit })
      log(`workspace ready: ${run.repo} on ${workspace.branch}`)
    }

    const result = await runLoop({
      step: async () => {
        const r = await step(runId, {
          llm: createSdkLlm({ env: process.env }),
          store,
          github: (repo: string) => {
            const { owner, name } = parseRepo(repo)
            if (!token) throw new Error('no gh token for GitHub access')
            return createGitHubClient({ owner, repo: name, token })
          },
          workspace: workspace && {
            dir: workspace.dir,
            async commit(message: string) {
              const res = await workspace!.commit(message)
              if (res.skipped.length > 0) log(`left ${res.skipped.length} secret-looking file(s) uncommitted`)
              if (res.committed) log(`committed and pushed ${workspace!.branch}`)
              return res.committed
            },
          },
          models,
          now: () => Date.now(),
        })
        // Same shape as lib/types.ts RunEvent, so the site can show it as-is.
        batcher.push({ at: Date.now(), message: r.action })
        return r
      },
      budgetMs: Number.POSITIVE_INFINITY,
      gapMs: STEP_GAP_MS,
      log,
      shouldStop: () => stopping,
    })
    log(`run ${runId} stopped: ${result.stoppedBy}, steps ${result.steps}, last ${result.lastAction ?? 'none'}`)
    // Shutdown stopped it with work left. Put it back so the next runner picks it up.
    if (result.stoppedBy === 'stopped') await requeueRun(c, runId)

    if (workspace) {
      const { pushed } = await workspace.finish()
      if (pushed) log(`final push of ${workspace.branch}`)
    }
  } catch (err) {
    log(`run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearInterval(refresh)
    await batcher.close()
    await workspace?.cleanup().catch(() => {})
  }
}

// One pass of the queue loop: returns how long to wait before the next pass.
async function pollOnce(c: UpstashClient, models: ReturnType<typeof resolveModels>): Promise<number> {
  const [runId] = await popQueue(c, 1)
  if (!runId) return IDLE_POLL_MS
  if (!validRunId(runId)) {
    log(`skipped queue entry with invalid run id`)
    return ACTIVE_POLL_MS
  }
  if (!(await claimRun(c, runId, runnerId, CLAIM_TTL_SEC))) {
    log(`run ${runId} is claimed elsewhere`)
    return ACTIVE_POLL_MS
  }
  activeRunId = runId
  log(`claimed run ${runId}`)
  try {
    await processRun(runId, c, models)
  } finally {
    await releaseClaim(c, runId, runnerId).catch((err: unknown) =>
      log(`release failed: ${err instanceof Error ? err.message : String(err)}`))
    activeRunId = null
  }
  return ACTIVE_POLL_MS
}

async function main(): Promise<number> {
  loadEnv()
  const missing = missingEnv(process.env)
  if (missing.length > 0) {
    log(`missing required env: ${missing.join(', ')} (set them in scripts/.env or runner.env)`)
    return 1
  }
  for (const k of REQUIRED_ENV) {
    const v = process.env[k]
    if (v) secrets.push(v)
  }

  const url = process.env.UPSTASH_REDIS_REST_URL as string
  const token = process.env.UPSTASH_REDIS_REST_TOKEN as string
  client = createUpstashClient({ url, token })
  runnerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
  const models = resolveModels(process.env, true)

  const hb: Heartbeat = startHeartbeat({
    client,
    info: { runnerId, pid: process.pid, host: hostname(), startedAt: Date.now() },
    onError: (err) => log(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`),
  })
  log(`runner ${runnerId} up; polling every ${IDLE_POLL_MS / 1000} s idle, ${ACTIVE_POLL_MS / 1000} s active (heartbeat ${HEARTBEAT_INTERVAL_MS / 1000} s)`)

  const onSignal = (sig: string) => {
    if (stopping) return
    stopping = true
    log(`${sig}: finishing the current step, then exiting`)
    for (const wake of wakers) wake()
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  try {
    while (!stopping) {
      let wait: number
      try {
        wait = await pollOnce(client, models)
      } catch (err) {
        log(`poll failed: ${err instanceof Error ? err.message : String(err)}`)
        wait = IDLE_POLL_MS
      }
      if (!stopping) await pause(wait)
    }
  } finally {
    await hb.stop()
    log('runner stopped')
  }
  return 0
}

// Crash path: best effort to release the claim and clear the heartbeat, then exit non-zero so the
// scheduled task restarts us. The site sees the claim expire anyway, so this is only a shortcut.
async function crash(err: unknown): Promise<never> {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`)
  if (client) {
    const tidy = (async () => {
      if (activeRunId) await releaseClaim(client!, activeRunId, runnerId).catch(() => {})
    })()
    await Promise.race([tidy, new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))])
  }
  process.exit(1)
}

process.on('uncaughtException', (err) => void crash(err))
process.on('unhandledRejection', (err) => void crash(err))

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => void crash(err))
