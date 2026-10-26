// Runner env: a git-ignored local file (scripts/.env or runner.env) plus process env.
// Pure parsing and checks, so they can be tested without touching the disk or the network.

// Keys the runner cannot work without. Values are never logged; only names.
export const REQUIRED_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
] as const

// Files tried in order. The first existing file wins for each key; process env wins over all.
export const ENV_FILES = ['scripts/.env', 'runner.env'] as const

const RUN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Minimal dotenv: KEY=value per line, optional "export " prefix, '#' comments, single or double
// quotes stripped. No variable expansion, so a value is always exactly what was written.
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const body = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!KEY_RE.test(key)) continue
    let value = body.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// Merges file values under process env. Empty strings in process env do not hide file values.
export function mergeEnv(
  fileValues: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...fileValues }
  for (const [k, v] of Object.entries(processEnv)) {
    if (v !== undefined && v !== '') merged[k] = v
  }
  return merged
}

// Subscription billing only. An API key in the environment would bill the API account instead,
// so it is removed and reported by name.
export function stripApiKey(env: Record<string, string | undefined>): { removed: boolean } {
  if (!env.ANTHROPIC_API_KEY) return { removed: false }
  delete env.ANTHROPIC_API_KEY
  return { removed: true }
}

// Returns the names of missing or empty variables. Never returns values.
export function missingEnv(env: Record<string, string | undefined>): string[] {
  return REQUIRED_ENV.filter((name) => !env[name])
}

export function validRunId(runId: string | undefined): runId is string {
  return typeof runId === 'string' && RUN_ID_RE.test(runId)
}
