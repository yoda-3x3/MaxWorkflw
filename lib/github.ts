// GitHub access for MaxWorkflw runs.
//
// Every operation is scoped to the branch `workflwpro/<runId>`. The branch is
// created on demand from the repo's default branch. There is no delete and no
// force-push. Merging is only possible through mergePR, and only when the
// caller passes `explicit: true`. dispatchRunWorkflow starts a workflow run
// and does not touch any branch.

export const BRANCH_PREFIX = 'workflwpro/';

const API_VERSION = '2022-11-28';
const DEFAULT_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Defaults to https://api.github.com */
  apiBase?: string;
  /** Attempts for operations that can hit 409/422 races. Default 3. */
  maxAttempts?: number;
  /** Delay between retry attempts in ms. Default 250. */
  retryDelayMs?: number;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

export interface FileEntry {
  name: string;
  path: string;
  type: string;
  size: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  sha: string;
}

export interface WriteFileResult {
  path: string;
  sha: string;
  commit: string;
}

export interface OpenPROptions {
  title: string;
  body?: string;
  /** Defaults to the repo's default branch. */
  base?: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
  state: string;
}

export interface MergePROptions {
  prNumber: number;
  /** Must be exactly true. Merging is never implicit. */
  explicit: boolean;
  /** Defaults to squash. */
  mergeMethod?: 'merge' | 'squash' | 'rebase';
}

export interface MergePRResult {
  merged: boolean;
  sha: string;
}

/**
 * Throws PathPolicyError unless the run id is safe to use in a branch name or a
 * workflow input. Run ids are restricted so they cannot escape the `workflwpro/` namespace.
 */
export function assertRunId(runId: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(runId)
    || runId.includes('..') || runId.endsWith('.')) {
    throw new PathPolicyError(`invalid run id: ${JSON.stringify(runId)}`);
  }
  return runId;
}

/** Validates a run id and returns the branch name for it. */
export function branchForRun(runId: string): string {
  return BRANCH_PREFIX + assertRunId(runId);
}

function isBlockedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return lower === '.git' || lower.startsWith('.env');
}

/**
 * Returns a reason string if the path must not be touched, or null if it is allowed.
 * Checks both the raw and the percent-decoded form, so `%2e%2e` and `.%67it` are
 * caught as well.
 */
export function pathViolation(path: string): string | null {
  if (path === '') return null;
  if (/[\0-\x1f\x7f\\]/.test(path)) return 'control characters or backslashes';
  if (path.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(path)) return 'drive-qualified path';

  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return 'malformed percent-encoding';
  }
  if (decoded !== path && (/[\0-\x1f\x7f\\]/.test(decoded) || decoded.startsWith('/'))) {
    return 'encoded traversal characters';
  }

  for (const form of [path, decoded]) {
    for (const segment of form.split('/')) {
      if (segment === '') return 'empty path segment';
      if (segment === '.' || segment === '..') return 'path traversal';
      if (isBlockedSegment(segment)) return `blocked path segment ${JSON.stringify(segment)}`;
    }
  }
  return null;
}

/** Throws PathPolicyError if the path is not allowed. Returns the path unchanged. */
export function validateRepoPath(path: string): string {
  const reason = pathViolation(path);
  if (reason) throw new PathPolicyError(`path ${JSON.stringify(path)} rejected: ${reason}`);
  return path;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isRetryable(err: unknown): boolean {
  return err instanceof GitHubError && (err.status === 409 || err.status === 422);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One GitHub REST call. Timeouts surface as GitHubError 408. */
async function githubRequest<T = any>(
  doFetch: typeof fetch,
  apiBase: string,
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await doFetch(apiBase + path, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new GitHubError(408, `GitHub ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  if (!res.ok) {
    let detail = '';
    try {
      const data: any = await res.json();
      detail = data?.message ? `: ${data.message}` : '';
    } catch {
      // Response body is not JSON. The status is enough.
    }
    throw new GitHubError(res.status, `GitHub ${method} ${path} failed with ${res.status}${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function createGitHubClient(opts: GitHubClientOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 250;
  const repoPath = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;

  const request = <T = any>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> =>
    githubRequest<T>(doFetch, apiBase, opts.token, method, path, body);

  /** Returns the sha of the ref, or null if it does not exist. */
  async function getRefSha(branch: string): Promise<string | null> {
    try {
      const ref: any = await request('GET', `${repoPath}/git/ref/heads/${encodePath(branch)}`);
      return ref.object.sha as string;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /** Creates workflwpro/<runId> from the default branch if it is missing. Never moves an existing ref. */
  async function ensureBranch(runId: string): Promise<string> {
    const branch = branchForRun(runId);
    for (let attempt = 1; ; attempt++) {
      if (await getRefSha(branch)) return branch;
      try {
        const repo: any = await request('GET', repoPath);
        const base = await getRefSha(repo.default_branch);
        if (!base) throw new GitHubError(404, `default branch ${repo.default_branch} not found`);
        await request('POST', `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: base });
        return branch;
      } catch (err) {
        // 409/422 means another writer created the branch first. Loop and check again.
        if (isRetryable(err) && attempt < maxAttempts) {
          await sleep(retryDelayMs);
          continue;
        }
        throw err;
      }
    }
  }

  async function listFiles(runId: string, dir = ''): Promise<FileEntry[]> {
    validateRepoPath(dir);
    const branch = await ensureBranch(runId);
    const target = dir ? `/contents/${encodePath(dir)}` : '/contents';
    const entries: any[] = await request('GET', `${repoPath}${target}?ref=${encodeURIComponent(branch)}`);
    if (!Array.isArray(entries)) throw new GitHubError(422, `${JSON.stringify(dir)} is not a directory`);
    // Hide blocked entries so they are never offered to the model.
    return entries
      .filter((e) => pathViolation(e.path) === null)
      .map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
  }

  async function readFile(runId: string, path: string): Promise<ReadFileResult> {
    validateRepoPath(path);
    if (path === '') throw new PathPolicyError('read_file needs a file path');
    const branch = await ensureBranch(runId);
    const file: any = await request('GET', `${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    if (Array.isArray(file) || file.type !== 'file') throw new GitHubError(422, `${path} is not a file`);
    if (file.encoding !== 'base64') throw new GitHubError(422, `${path} is too large to read through the contents API`);
    return { path, content: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha };
  }

  async function writeFile(runId: string, path: string, content: string): Promise<WriteFileResult> {
    validateRepoPath(path);
    if (path === '') throw new PathPolicyError('write_file needs a file path');
    const branch = await ensureBranch(runId);
    const url = `${repoPath}/contents/${encodePath(path)}`;
    for (let attempt = 1; ; attempt++) {
      try {
        // Re-read the sha each attempt, since a concurrent write changes it.
        let sha: string | undefined;
        try {
          const current: any = await request('GET', `${url}?ref=${encodeURIComponent(branch)}`);
          if (!Array.isArray(current) && current.type === 'file') sha = current.sha;
        } catch (err) {
          if (!(err instanceof GitHubError && err.status === 404)) throw err;
        }
        const res: any = await request('PUT', url, {
          message: `maxworkflw: update ${path}`,
          content: Buffer.from(content, 'utf8').toString('base64'),
          branch,
          ...(sha ? { sha } : {}),
        });
        return { path, sha: res.content.sha, commit: res.commit.sha };
      } catch (err) {
        if (isRetryable(err) && attempt < maxAttempts) {
          await sleep(retryDelayMs);
          continue;
        }
        throw err;
      }
    }
  }

  async function openPR(runId: string, opt: OpenPROptions): Promise<PullRequestResult> {
    const branch = await ensureBranch(runId);
    const base = opt.base ?? ((await request<any>('GET', repoPath)).default_branch as string);
    try {
      const pr: any = await request('POST', `${repoPath}/pulls`, {
        title: opt.title,
        body: opt.body ?? '',
        head: branch,
        base,
      });
      return { number: pr.number, url: pr.html_url, state: pr.state };
    } catch (err) {
      // 422 is GitHub's answer when an open PR already exists for this head.
      if (!(err instanceof GitHubError && err.status === 422)) throw err;
      const existing: any[] = await request(
        'GET',
        `${repoPath}/pulls?head=${encodeURIComponent(`${opts.owner}:${branch}`)}&state=open&base=${encodeURIComponent(base)}`,
      );
      if (existing.length === 0) throw err;
      return { number: existing[0].number, url: existing[0].html_url, state: existing[0].state };
    }
  }

  async function mergePR(runId: string, opt: MergePROptions): Promise<MergePRResult> {
    if (opt.explicit !== true) {
      throw new GitHubError(403, 'mergePR requires explicit: true');
    }
    const branch = branchForRun(runId);
    const pr: any = await request('GET', `${repoPath}/pulls/${opt.prNumber}`);
    if (pr.head?.ref !== branch || pr.head?.repo?.full_name !== `${opts.owner}/${opts.repo}`) {
      throw new PathPolicyError(`PR #${opt.prNumber} is not a same-repo PR from ${branch}`);
    }
    const res: any = await request('PUT', `${repoPath}/pulls/${opt.prNumber}/merge`, {
      merge_method: opt.mergeMethod ?? 'squash',
    });
    return { merged: res.merged === true, sha: res.sha };
  }

  return { listFiles, readFile, writeFile, openPR, mergePR };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
