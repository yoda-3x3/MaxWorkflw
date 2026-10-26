// Git helpers for the runner's repo workspace. Argument building and path filtering are pure.
// Git runs through an injected Exec so tests never touch the network or disk.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redact } from './redact'

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type Exec = (args: string[], opts: ExecOptions) => Promise<ExecResult>

export const BRANCH_PREFIX = 'workflwpro/'
export const COMMIT_AUTHOR = { name: 'WorkflwPro', email: 'noreply@workflwpro.vercel.app' }

// No leading "-" or "." on any part, so nothing can read as a git option.
const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const RUN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/

// The agent writes into this clone, so it can plant repo-local config or hooks. Every git call
// the runner makes goes through these overrides, which win over anything in .git/config:
// no hooks, no fsmonitor program, no ssh command, no ext:: transport. GIT_CONFIG_NOSYSTEM stops
// the host's /etc/gitconfig from adding its own.
export const GIT_HARDENING = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=',
  '-c', 'protocol.ext.allow=never',
]

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }

export class GitError extends Error {}

export function parseRepo(repo: string): { owner: string; name: string } {
  if (!REPO_RE.test(repo)) throw new GitError('repo must be owner/name')
  const [owner, name] = repo.split('/')
  return { owner, name }
}

export function workspaceBranch(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new GitError('invalid run id')
  return BRANCH_PREFIX + runId
}

export function cloneUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`
}

// Token goes in an HTTP header, not the URL, so it never lands in .git/config.
export function basicAuthHeader(token: string): string {
  return 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${token}`).toString('base64')
}

export function authConfigArgs(token: string): string[] {
  return ['-c', `http.https://github.com/.extraheader=${basicAuthHeader(token)}`]
}

// Checked against every segment of a path, so `deploy/.env.production`, `keys/server.pem`
// and `sub/.git/config` are all caught, not just the basename.
const SECRET_LIKE_SEGMENT = [
  /^\.env(\..+)?$/, // .env, .env.local; templates are exempt below
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|[._-])(secrets?|credentials?)([._-]|\.|$)/i,
  /^(\.netrc|\.npmrc|\.git-credentials|\.ssh|\.gnupg|\.git)$/,
]
const TEMPLATE_ENV_RE = /^\.env\.(example|sample|template)$/

// True for paths that must never be committed: any segment looks like a secret or is inside .git.
export function isSecretLikePath(path: string): boolean {
  return path
    .split('/')
    .filter((seg) => seg.length > 0)
    .some((seg) => !TEMPLATE_ENV_RE.test(seg) && SECRET_LIKE_SEGMENT.some((re) => re.test(seg)))
}

export function splitSecretPaths(paths: string[]): { keep: string[]; unstage: string[] } {
  const keep: string[] = []
  const unstage: string[] = []
  for (const p of paths) (isSecretLikePath(p) ? unstage : keep).push(p)
  return { keep, unstage }
}

// `git diff --cached --name-only -z` output: NUL-separated, trailing NUL.
export function parseNameList(stdout: string): string[] {
  return stdout.split('\0').filter((p) => p.length > 0)
}

export function buildCheckoutArgs(branch: string, startPoint: string): string[] {
  if (!BRANCH_RE.test(branch) || branch.includes('..')) throw new GitError('invalid branch name')
  return ['checkout', '-B', branch, startPoint]
}

export function buildCommitArgs(message: string): string[] {
  return [
    '-c', `user.name=${COMMIT_AUTHOR.name}`,
    '-c', `user.email=${COMMIT_AUTHOR.email}`,
    'commit', '-q', '-m', message,
  ]
}

// Plain push of the current branch. Never force, never delete.
export function buildPushArgs(): string[] {
  return ['push', 'origin', 'HEAD']
}

// Count of local commits not yet on the default branch.
export function buildAheadArgs(defaultBranch: string): string[] {
  if (!BRANCH_RE.test(defaultBranch) || defaultBranch.includes('..')) throw new GitError('invalid branch name')
  return ['rev-list', '--count', `origin/${defaultBranch}..HEAD`]
}

export interface Workspace {
  /** Checked-out clone. Pass as cwd for tools that edit files. */
  dir: string
  branch: string
  defaultBranch: string
  /**
   * Stage everything except secret-looking files, commit if anything changed, then push at once
   * so a killed job or a re-clone never loses the commit. Throws if the push is rejected.
   */
  commit(message: string): Promise<{ committed: boolean; skipped: string[] }>
  /** Safety net at the end of a job: pushes only when the branch has commits beyond the default branch. */
  finish(): Promise<{ pushed: boolean }>
  cleanup(): Promise<void>
}

export interface PrepareOptions {
  repo: string
  runId: string
  /** Optional. Unset means the PC's own git credential helper or gh login is used. */
  token?: string
  exec: Exec
  /** Parent directory for the clone. Defaults to a fresh mkdtemp under the OS tmpdir. */
  makeTempDir?: () => Promise<string>
  removeDir?: (dir: string) => Promise<void>
}

export async function prepareWorkspace(opts: PrepareOptions): Promise<Workspace> {
  const { owner, name } = parseRepo(opts.repo)
  const branch = workspaceBranch(opts.runId)
  const secrets = opts.token ? [opts.token, basicAuthHeader(opts.token)] : []
  const makeTempDir = opts.makeTempDir ?? (() => mkdtemp(join(tmpdir(), 'workflwpro-')))
  const removeDir = opts.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }))

  const root = await makeTempDir()
  const dir = join(root, 'repo')

  const git = async (args: string[], cwd: string | undefined, label: string, auth = false): Promise<ExecResult> => {
    const useToken = auth && opts.token ? authConfigArgs(opts.token) : []
    const full = [...GIT_HARDENING, ...useToken, ...args]
    const r = await opts.exec(full, { cwd, env: GIT_ENV })
    if (r.code !== 0) {
      const last = r.stderr.trim().split('\n').pop() ?? ''
      throw new GitError(`${label} failed (exit ${r.code}): ${redact(last, secrets)}`)
    }
    return r
  }

  try {
    await git(['clone', '-q', cloneUrl(owner, name), dir], undefined, 'clone', true)

    const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir, 'default branch')
    const defaultBranch = head.stdout.trim().replace(/^origin\//, '')
    if (!BRANCH_RE.test(defaultBranch)) throw new GitError('could not read default branch')

    const remote = await git(['ls-remote', '--heads', 'origin', branch], dir, 'ls-remote', true)
    if (remote.stdout.trim()) {
      // Reuse: a previous job for this run already pushed the branch.
      await git(
        ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        dir, 'fetch', true,
      )
      await git(buildCheckoutArgs(branch, `origin/${branch}`), dir, 'checkout')
    } else {
      await git(buildCheckoutArgs(branch, `origin/${defaultBranch}`), dir, 'checkout')
    }

    return {
      dir,
      branch,
      defaultBranch,
      async commit(message) {
        await git(['add', '-A'], dir, 'add')
        const staged = await git(['diff', '--cached', '--name-only', '-z'], dir, 'diff')
        const { unstage } = splitSecretPaths(parseNameList(staged.stdout))
        if (unstage.length > 0) await git(['reset', '-q', '--', ...unstage], dir, 'reset')
        // `diff --cached --quiet` exits 1 when something is staged.
        const pending = await opts.exec([...GIT_HARDENING, 'diff', '--cached', '--quiet'], { cwd: dir, env: GIT_ENV })
        if (pending.code === 0) return { committed: false, skipped: unstage }
        await git(buildCommitArgs(message), dir, 'commit')
        await git(buildPushArgs(), dir, 'push', true)
        return { committed: true, skipped: unstage }
      },
      async finish() {
        const ahead = await git(buildAheadArgs(defaultBranch), dir, 'rev-list')
        if (Number(ahead.stdout.trim()) === 0) return { pushed: false }
        await git(buildPushArgs(), dir, 'push', true)
        return { pushed: true }
      },
      async cleanup() {
        await removeDir(root)
      },
    }
  } catch (err) {
    await removeDir(root).catch(() => {})
    throw err
  }
}

// Production exec: runs the git binary with no shell, so arguments are never interpreted.
export const execGit: Exec = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
