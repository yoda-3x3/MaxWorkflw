// Long-running runner on this PC. Polls the Upstash queue for runs, claims one, drives the engine
// with the Claude Agent SDK (subscription billing), and keeps a heartbeat so the site can show it is up.
// Start with `npm run runner`. Install as a logon task with scripts/install-runner-task.ps1.
import { readFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { step } from '../lib/engine'
import { createGitHubClient } from '../lib/github'
import { resolveModels } from '../lib/llm'
import { getRunStore } from '../lib/store'
import { createSdkLlm, usageLimitFrom } from './lib/sdk-llm'
import { answerQueuedChats } from './lib/chat'
import type { Placement } from '../lib/types'
import {
  isFinishedStatus,
  prepareRunAttachments,
  resolveWorkDir,
  type AttachmentFs,
  type PreparedAttachments,
} from './lib/attachments'
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
  PING_PREFIX,
  popQueue,
  refreshClaim,
  requeueRun,
  releaseClaim,
  writePong,
  type QueueName,
  type UpstashClient,
} from './lib/upstash'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IDLE_POLL_MS = 15_000
const ACTIVE_POLL_MS = 2_000
const STEP_GAP_MS = 2_000
const CLAIM_TTL_SEC = 120
const CLAIM_REFRESH_MS = 30_000
const SHUTDOWN_GRACE_MS = 3_000
// --cloud: the GitHub Actions runner. Reads the cloud queue, sends no PC heartbeat, and exits once
// the queue is empty (the site starts a new one when it queues more work).
const CLOUD = process.argv.includes('--cloud')
const QUEUE: QueueName = CLOUD ? 'cloud' : 'pc'
const PLACEMENT: Placement = CLOUD ? 'cloud' : 'pc'

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

// Node filesystem for the attachment step. A missing uploads folder is an empty listing, not an error.
const nodeFs: AttachmentFs = {
  mkdir: async (dir) => { await mkdir(dir, { recursive: true }) },
  writeFile: (path, data) => writeFile(path, data),
  readdir: (dir) => readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  }),
}

// Answers queued Orchestrator chat questions. Runs between engine steps and when idle, so a chat
// waits at most one step. Never throws: a chat problem must not stop the run or the queue.
async function answerChats(models: ReturnType<typeof resolveModels>): Promise<number> {
  try {
    return await answerQueuedChats({
      store: getRunStore(),
      llm: createSdkLlm({ env: process.env }),
      model: models.orchestrator,
      placement: PLACEMENT,
      log,
    })
  } catch (err) {
    log(`chat queue failed: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
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
  let attachments: PreparedAttachments | undefined
  try {
    const token = run.repo ? await readGhToken() : undefined
    if (token) secrets.push(token)
    if (run.repo) {
      workspace = await prepareWorkspace({ repo: run.repo, runId, token, exec: execGit })
      log(`workspace ready: ${run.repo} on ${workspace.branch}`)
    }

    // Attachments: download what is not on disk yet, then tell the agent where they are.
    attachments = await prepareRunAttachments(runId, resolveWorkDir(process.env), store, nodeFs)
    if (attachments.paths.length > 0) log(`${attachments.paths.length} attachment(s) ready for run ${runId}`)

    const result = await runLoop({
      step: async () => {
        await answerChats(models)
        const r = await step(runId, {
          llm: createSdkLlm({
            env: process.env,
            attachmentPaths: attachments?.paths ?? [],
            attachmentsDir: attachments?.uploadsDir,
            onRateLimit: (info) => {
              const limit = usageLimitFrom(info)
              if (limit) void store.recordUsageLimit(limit).catch(() => undefined)
            },
          }),
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
    if (result.stoppedBy === 'stopped') await requeueRun(c, runId, QUEUE)

    if (workspace) {
      const { pushed } = await workspace.finish()
      if (pushed) log(`final push of ${workspace.branch}`)
    }
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err), secrets)
    log(`run ${runId} failed: ${reason}`)
    // Setup failed before the engine ever ran (clone, attachments...). Fail the run with the reason,
    // so the site shows it instead of the run sitting at "queued" forever.
    const latest = await store.getRunForEngine(runId).catch(() => null)
    if (latest && latest.status === 'queued') {
      const at = Date.now()
      latest.status = 'failed'
      latest.error = `The runner couldn't start this run: ${reason}`.slice(0, 500)
      latest.events.push({ at, message: latest.error })
      latest.updatedAt = at
      await store.saveRun(latest).catch((e: unknown) => log(`could not record the failure: ${e instanceof Error ? e.message : String(e)}`))
    }
  } finally {
    clearInterval(refresh)
    await batcher.close()
    await workspace?.cleanup().catch(() => {})
    // Files stay on disk until the run is finished, so a later claim still finds them.
    if (attachments) {
      const latest = await store.getRunForEngine(runId).catch(() => null)
      if (latest && isFinishedStatus(latest.status)) await rm(attachments.runDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// One pass of the queue loop: returns how long to wait before the next pass.
async function pollOnce(c: UpstashClient, models: ReturnType<typeof resolveModels>): Promise<number> {
  if ((await answerChats(models)) > 0) return ACTIVE_POLL_MS
  const [runId] = await popQueue(c, 1, QUEUE)
  if (!runId) return IDLE_POLL_MS
  if (runId.startsWith(PING_PREFIX)) {
    const nonce = runId.slice(PING_PREFIX.length)
    if (/^[A-Za-z0-9-]{8,64}$/.test(nonce)) {
      await writePong(c, nonce, hostname(), runnerId)
      log('answered a ping')
    }
    return ACTIVE_POLL_MS
  }
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

  // The heartbeat means "the PC is online"; the cloud runner must not claim that.
  const hb: Heartbeat = CLOUD
    ? { stop: async () => {} }
    : startHeartbeat({
        client,
        info: { runnerId, pid: process.pid, host: hostname(), startedAt: Date.now() },
        onError: (err) => log(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`),
      })
  log(CLOUD
    ? `cloud runner ${runnerId} up; working the cloud queue until it is empty`
    : `runner ${runnerId} up; polling every ${IDLE_POLL_MS / 1000} s idle, ${ACTIVE_POLL_MS / 1000} s active (heartbeat ${HEARTBEAT_INTERVAL_MS / 1000} s)`)

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
      // An empty cloud queue means this Actions job is done.
      if (CLOUD && wait === IDLE_POLL_MS) break
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
