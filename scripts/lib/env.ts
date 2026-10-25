// Required env for the GitHub Actions runner. Pure, so it can be tested without a process.
export const REQUIRED_ENV = [
  'RUN_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'GH_REPO_TOKEN',
] as const

const RUN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/

// Returns the names of missing or empty variables. Never returns values.
export function missingEnv(env: Record<string, string | undefined>): string[] {
  return REQUIRED_ENV.filter((name) => !env[name])
}

export function validRunId(runId: string | undefined): runId is string {
  return typeof runId === 'string' && RUN_ID_RE.test(runId)
}
