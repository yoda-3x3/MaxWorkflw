// GitHub Actions entry point. Advances one run until the engine stops needing steps,
// or until the time budget is spent. The cron re-dispatches runs that are still active.
import { step } from '../lib/engine'
import { createGitHubClient } from '../lib/github'
import { resolveModels } from '../lib/llm'
import { createClaudeCliLlm } from '../lib/claude-cli'
import { getRunStore } from '../lib/store'
import { missingEnv, validRunId } from './lib/env'
import { execGit, parseRepo, prepareWorkspace, type Workspace } from './lib/git'
import { redact } from './lib/redact'
import { runLoop } from './lib/loop'

// Job timeout is 330 min. Stop starting steps at 5h so the last one finishes inside it.
const BUDGET_MS = 5 * 60 * 60 * 1000
const STEP_GAP_MS = 1000

// Filled once the env is validated. Used to scrub errors after the env vars are deleted.
const secrets: string[] = []

function log(line: string) {
  console.log(redact(line, secrets))
}

async function main(): Promise<number> {
  const env = process.env
  // The runner bills through the Claude OAuth token. An API key would bill elsewhere.
  if (env.ANTHROPIC_API_KEY) {
    delete env.ANTHROPIC_API_KEY
    log('ignored ANTHROPIC_API_KEY; using CLAUDE_CODE_OAUTH_TOKEN')
  }

  const missing = missingEnv(env)
  if (missing.length > 0) {
    log(`missing required env: ${missing.join(', ')}`)
    return 1
  }
  const runId = env.RUN_ID as string
  if (!validRunId(runId)) {
    log('RUN_ID must be 1-128 letters, digits, "_" or "-"')
    return 1
  }
  secrets.push(env.CLAUDE_CODE_OAUTH_TOKEN as string, env.GH_REPO_TOKEN as string,
    env.UPSTASH_REDIS_REST_TOKEN as string)

  // Read the values into locals first: the env vars are deleted below, before the agent runs.
  const token = env.GH_REPO_TOKEN as string
  // getRunStore() copies the Upstash URL and token when it is first created, so it must run before the delete.
  const store = getRunStore()
  const run = await store.getRunForEngine(runId)
  if (!run) {
    log(`run ${runId} not found`)
    return 1
  }

  let workspace: Workspace | undefined
  if (run.repo) {
    workspace = await prepareWorkspace({ repo: run.repo, runId, token, exec: execGit })
    log(`workspace ready: ${run.repo} on ${workspace.branch}`)
  }

  // The claude subprocess inherits this env. Remove what agents must not see.
  delete env.GH_REPO_TOKEN
  delete env.UPSTASH_REDIS_REST_URL
  delete env.UPSTASH_REDIS_REST_TOKEN

  try {
    const deps = {
      llm: createClaudeCliLlm(),
      store,
      github: (repo: string) => {
        const { owner, name } = parseRepo(repo)
        return createGitHubClient({ owner, repo: name, token })
      },
      workspace: workspace && {
        dir: workspace.dir,
        async commit(message: string) {
          const result = await workspace!.commit(message)
          if (result.skipped.length > 0) log(`left ${result.skipped.length} secret-looking file(s) uncommitted`)
          if (result.committed) log(`committed and pushed ${workspace!.branch}`)
          return result.committed
        },
      },
      models: resolveModels(env, true),
      now: () => Date.now(),
    }

    const result = await runLoop({
      step: () => step(runId, deps),
      budgetMs: BUDGET_MS,
      gapMs: STEP_GAP_MS,
      log,
    })
    log(`stopped: ${result.stoppedBy}, steps ${result.steps}, last ${result.lastAction ?? 'none'}`)

    if (workspace) {
      const { pushed } = await workspace.finish()
      if (pushed) log(`final push of ${workspace.branch}`)
    }
    return 0
  } finally {
    await workspace?.cleanup()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(redact(message, secrets))
    process.exitCode = 1
  })
