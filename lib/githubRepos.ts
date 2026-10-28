// Lists the GitHub repos the repo picker offers. Query parsing, filtering and paging are pure.
// The one network call takes an injected fetch so tests never reach GitHub.
//
// GitHub's repo list is paged by GitHub, but the picker filters by name, so we read up to
// MAX_PAGES pages (1000 repos) and filter and page in memory. `truncated` tells the UI when
// repos beyond that cap may be missing. Typing owner/name still works for those.

export const REPO_PAGE_SIZE = 100;
export const REPO_LIST_MAX_PAGES = 10;
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;
const MAX_QUERY_CHARS = 100;
const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 10_000;

export interface GitHubRepoSummary {
  /** owner/name */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}

export interface RepoPage {
  repos: GitHubRepoSummary[];
  page: number;
  perPage: number;
  /** Matches for the query across everything that was read, not just this page. */
  total: number;
  hasMore: boolean;
  /** True when the account has more repos than were read, so some may be missing. */
  truncated: boolean;
}

export interface RepoListQuery {
  q: string;
  page: number;
  perPage: number;
}

export class GitHubRepoListError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubRepoListError';
    this.status = status;
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Reads ?q, ?page and ?perPage. Bad or missing numbers fall back to defaults; nothing throws. */
export function parseRepoListQuery(params: URLSearchParams): RepoListQuery {
  return {
    q: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS),
    page: clampInt(params.get('page'), 1, 1, 100_000),
    perPage: clampInt(params.get('perPage'), DEFAULT_PER_PAGE, 1, MAX_PER_PAGE),
  };
}

/** Case-insensitive substring match on owner/name. An empty query matches everything. */
export function filterRepos(repos: GitHubRepoSummary[], q: string): GitHubRepoSummary[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return repos;
  return repos.filter((r) => r.fullName.toLowerCase().includes(needle));
}

/** Filters, then returns one page of the result. Pages are 1-based. */
export function selectRepoPage(
  repos: GitHubRepoSummary[],
  query: RepoListQuery,
  truncated: boolean,
): RepoPage {
  const matches = filterRepos(repos, query.q);
  const start = (query.page - 1) * query.perPage;
  return {
    repos: matches.slice(start, start + query.perPage),
    page: query.page,
    perPage: query.perPage,
    total: matches.length,
    hasMore: start + query.perPage < matches.length,
    truncated,
  };
}

/** Maps one item from GET /user/repos. Returns null for anything that does not have the expected shape. */
export function toRepoSummary(raw: unknown): GitHubRepoSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const owner = r.owner as { login?: unknown } | null | undefined;
  if (typeof r.full_name !== 'string' || typeof r.name !== 'string') return null;
  if (typeof owner?.login !== 'string' || typeof r.private !== 'boolean') return null;
  if (typeof r.default_branch !== 'string') return null;
  return {
    fullName: r.full_name,
    owner: owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch,
  };
}

export interface ListReposOptions {
  token: string;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Defaults to https://api.github.com */
  apiBase?: string;
  /** Defaults to REPO_LIST_MAX_PAGES. */
  maxPages?: number;
}

/**
 * Reads the repos the token can access (owner, collaborator and org member), newest pushed first.
 * Duplicates across pages are dropped. The token is only sent in the Authorization header.
 */
export async function listAccessibleRepos(opts: ListReposOptions): Promise<{ repos: GitHubRepoSummary[]; truncated: boolean }> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const maxPages = opts.maxPages ?? REPO_LIST_MAX_PAGES;
  const seen = new Map<string, GitHubRepoSummary>();

  for (let page = 1; page <= maxPages; page++) {
    const res = await doFetch(`${apiBase}/user/repos?per_page=${REPO_PAGE_SIZE}&page=${page}&sort=pushed`, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'WorkflwPro',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new GitHubRepoListError(res.status, `GitHub returned ${res.status} for the repo list`);
    const batch: unknown = await res.json();
    if (!Array.isArray(batch)) throw new GitHubRepoListError(502, 'GitHub sent an unexpected repo list');
    for (const item of batch) {
      const repo = toRepoSummary(item);
      if (repo && !seen.has(repo.fullName)) seen.set(repo.fullName, repo);
    }
    if (batch.length < REPO_PAGE_SIZE) return { repos: [...seen.values()], truncated: false };
  }
  return { repos: [...seen.values()], truncated: true };
}
