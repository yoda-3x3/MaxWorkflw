import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubClient,
  branchForRun,
  pathViolation,
  validateRepoPath,
  GitHubError,
  PathPolicyError,
} from '../lib/github';

type Call = { method: string; url: string; body: any };
type Responder = (call: Call) => { status: number; json?: unknown } | undefined;

// Mock fetch. Calls not matched by a responder get a 404.
function mockFetch(responders: Responder[] = []) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input).replace('https://api.github.com', ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const r of responders) {
      const hit = r(call);
      if (hit) {
        return new Response(hit.json === undefined ? null : JSON.stringify(hit.json), {
          status: hit.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const repoRoute: Responder = (c) =>
  c.method === 'GET' && c.url === '/repos/acme/app'
    ? { status: 200, json: { default_branch: 'main' } }
    : undefined;

const mainRefRoute: Responder = (c) =>
  c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/main'
    ? { status: 200, json: { object: { sha: 'base-sha' } } }
    : undefined;

function client(fetchFn: typeof fetch, extra: Partial<Parameters<typeof createGitHubClient>[0]> = {}) {
  return createGitHubClient({
    owner: 'acme',
    repo: 'app',
    token: 'test-token',
    fetch: fetchFn,
    retryDelayMs: 0,
    ...extra,
  });
}

const blockedPaths = [
  '../secret.txt',
  'a/../../b',
  'a/./b',
  '/etc/passwd',
  'a//b',
  'src/',
  '.git/config',
  'sub/.git/HEAD',
  'sub/.GIT/x',
  '.env',
  '.env.local',
  'config/.env.production',
  '.envrc',
  'a\\b',
  'a\0b',
  'C:/Windows/x',
  '%2e%2e/secret',
  '%2e%2e%2fsecret',
  '.%67it/config',
  '%2Fetc%2Fpasswd',
  '%',
];

test('pathViolation blocks traversal, absolute paths, .git and .env', () => {
  for (const p of blockedPaths) {
    assert.notEqual(pathViolation(p), null, `expected ${JSON.stringify(p)} to be blocked`);
  }
});

test('pathViolation allows ordinary repo paths', () => {
  for (const p of ['README.md', 'src/index.ts', 'src/env.ts', 'a.git/x', 'docs/.github/x.yml', 'a..b/c', '']) {
    assert.equal(pathViolation(p), null, `expected ${JSON.stringify(p)} to be allowed`);
  }
});

test('validateRepoPath throws PathPolicyError for blocked paths', () => {
  assert.throws(() => validateRepoPath('../x'), PathPolicyError);
  assert.equal(validateRepoPath('src/a.ts'), 'src/a.ts');
});

test('branchForRun uses the workflwpro/ namespace and rejects bad run ids', () => {
  assert.equal(branchForRun('run-42'), 'workflwpro/run-42');
  for (const id of ['', '../main', 'a/b', 'a..b', 'run.', '-x y', 'a\nb']) {
    assert.throws(() => branchForRun(id), PathPolicyError, `expected run id ${JSON.stringify(id)} rejected`);
  }
});

test('blocked paths make no network calls for read, write and list', async () => {
  const { fetchFn, calls } = mockFetch([repoRoute, mainRefRoute]);
  const gh = client(fetchFn);
  await assert.rejects(gh.readFile('r1', '.env'), PathPolicyError);
  await assert.rejects(gh.readFile('r1', '../x'), PathPolicyError);
  await assert.rejects(gh.writeFile('r1', '.git/config', 'x'), PathPolicyError);
  await assert.rejects(gh.writeFile('r1', '', 'x'), PathPolicyError);
  await assert.rejects(gh.listFiles('r1', '.git'), PathPolicyError);
  assert.equal(calls.length, 0);
});

test('invalid run id makes no network calls', async () => {
  const { fetchFn, calls } = mockFetch([repoRoute, mainRefRoute]);
  const gh = client(fetchFn);
  await assert.rejects(gh.writeFile('../main', 'a.txt', 'x'), PathPolicyError);
  assert.equal(calls.length, 0);
});

test('ensureBranch creates workflwpro/<runId> from the default branch when missing', async () => {
  let created: Call | undefined;
  const { fetchFn } = mockFetch([
    repoRoute,
    mainRefRoute,
    (c) => {
      if (c.method === 'POST' && c.url === '/repos/acme/app/git/refs') {
        created = c;
        return { status: 201, json: {} };
      }
      return undefined;
    },
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/contents?ref=workflwpro%2Frun1'
      ? { status: 200, json: [] }
      : undefined),
  ]);
  await client(fetchFn).listFiles('run1');
  assert.deepEqual(created?.body, { ref: 'refs/heads/workflwpro/run1', sha: 'base-sha' });
});

test('ensureBranch does not recreate an existing branch', async () => {
  const { fetchFn, calls } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1'
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    (c) => (c.method === 'GET' && c.url.startsWith('/repos/acme/app/contents?ref=')
      ? { status: 200, json: [] }
      : undefined),
  ]);
  await client(fetchFn).listFiles('run1');
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('ensureBranch retries after a 409 race and succeeds once the branch exists', async () => {
  let refChecks = 0;
  let createAttempts = 0;
  const { fetchFn } = mockFetch([
    repoRoute,
    mainRefRoute,
    (c) => {
      if (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1') {
        refChecks++;
        // Missing on the first check, present after the other writer's create lands.
        return refChecks === 1 ? { status: 404 } : { status: 200, json: { object: { sha: 'x' } } };
      }
      if (c.method === 'POST' && c.url === '/repos/acme/app/git/refs') {
        createAttempts++;
        return { status: 409, json: { message: 'Reference already exists' } };
      }
      if (c.method === 'GET' && c.url.startsWith('/repos/acme/app/contents?ref=')) {
        return { status: 200, json: [] };
      }
      return undefined;
    },
  ]);
  await client(fetchFn).listFiles('run1');
  assert.equal(createAttempts, 1);
  assert.ok(refChecks >= 2);
});

test('ensureBranch gives up after maxAttempts 422s', async () => {
  const { fetchFn } = mockFetch([
    repoRoute,
    mainRefRoute,
    (c) => (c.method === 'POST' && c.url === '/repos/acme/app/git/refs'
      ? { status: 422, json: { message: 'Reference does not exist' } }
      : undefined),
  ]);
  await assert.rejects(client(fetchFn, { maxAttempts: 2 }).listFiles('run1'), (err: unknown) =>
    err instanceof GitHubError && err.status === 422);
});

test('writeFile writes only to the run branch and sends base64 content', async () => {
  const { fetchFn, calls } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1'
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/contents/src/a.ts?ref=workflwpro%2Frun1'
      ? { status: 200, json: { type: 'file', sha: 'old-sha' } }
      : undefined),
    (c) => (c.method === 'PUT' && c.url === '/repos/acme/app/contents/src/a.ts'
      ? { status: 200, json: { content: { sha: 'new-sha' }, commit: { sha: 'commit-sha' } } }
      : undefined),
  ]);
  const res = await client(fetchFn).writeFile('run1', 'src/a.ts', 'hello');
  assert.deepEqual(res, { path: 'src/a.ts', sha: 'new-sha', commit: 'commit-sha' });
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put?.body.branch, 'workflwpro/run1');
  assert.equal(put?.body.sha, 'old-sha');
  assert.equal(Buffer.from(put?.body.content, 'base64').toString('utf8'), 'hello');
  // Writes never target any other branch.
  for (const c of calls) {
    assert.doesNotMatch(c.url, /ref=(?!workflwpro%2F)/);
  }
});

test('writeFile creates a new file without a sha', async () => {
  const { fetchFn, calls } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1'
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    (c) => (c.method === 'PUT'
      ? { status: 201, json: { content: { sha: 's' }, commit: { sha: 'c' } } }
      : undefined),
  ]);
  await client(fetchFn).writeFile('run1', 'new.txt', 'x');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put?.body.sha, undefined);
});

test('writeFile retries on 409 and re-reads the sha', async () => {
  let puts = 0;
  let gets = 0;
  const { fetchFn } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1'
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    (c) => {
      if (c.method === 'GET' && c.url.startsWith('/repos/acme/app/contents/a.txt')) {
        gets++;
        return { status: 200, json: { type: 'file', sha: `sha-${gets}` } };
      }
      return undefined;
    },
    (c) => {
      if (c.method === 'PUT') {
        puts++;
        if (puts === 1) return { status: 409, json: { message: 'conflict' } };
        return { status: 200, json: { content: { sha: 's' }, commit: { sha: 'c' } } };
      }
      return undefined;
    },
  ]);
  await client(fetchFn).writeFile('run1', 'a.txt', 'x');
  assert.equal(puts, 2);
  assert.equal(gets, 2);
});

test('readFile decodes base64 content from the run branch', async () => {
  const { fetchFn } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1'
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/contents/README.md?ref=workflwpro%2Frun1'
      ? { status: 200, json: { type: 'file', encoding: 'base64', sha: 'abc', content: Buffer.from('hi there').toString('base64') } }
      : undefined),
  ]);
  const res = await client(fetchFn).readFile('run1', 'README.md');
  assert.deepEqual(res, { path: 'README.md', content: 'hi there', sha: 'abc' });
});

test('listFiles hides blocked entries such as .env files', async () => {
  const { fetchFn } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1'
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/contents/src?ref=workflwpro%2Frun1'
      ? {
          status: 200,
          json: [
            { name: 'a.ts', path: 'src/a.ts', type: 'file', size: 3 },
            { name: '.env', path: 'src/.env', type: 'file', size: 9 },
          ],
        }
      : undefined),
  ]);
  const files = await client(fetchFn).listFiles('run1', 'src');
  assert.deepEqual(files.map((f) => f.path), ['src/a.ts']);
});

test('openPR opens a PR from the run branch into the default branch', async () => {
  const { fetchFn, calls } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1'
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    repoRoute,
    (c) => (c.method === 'POST' && c.url === '/repos/acme/app/pulls'
      ? { status: 201, json: { number: 7, html_url: 'https://github.com/acme/app/pull/7', state: 'open' } }
      : undefined),
  ]);
  const pr = await client(fetchFn).openPR('run1', { title: 'T', body: 'B' });
  assert.deepEqual(pr, { number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open' });
  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'));
  assert.deepEqual(post?.body, { title: 'T', body: 'B', head: 'workflwpro/run1', base: 'main' });
});

test('openPR returns the existing open PR on 422', async () => {
  const { fetchFn } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/git/ref/heads/workflwpro/run1'
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    repoRoute,
    (c) => (c.method === 'POST' && c.url === '/repos/acme/app/pulls'
      ? { status: 422, json: { message: 'A pull request already exists' } }
      : undefined),
    (c) => (c.method === 'GET' && c.url.startsWith('/repos/acme/app/pulls?head=')
      ? { status: 200, json: [{ number: 3, html_url: 'u', state: 'open' }] }
      : undefined),
  ]);
  const pr = await client(fetchFn).openPR('run1', { title: 'T' });
  assert.equal(pr.number, 3);
});

test('mergePR refuses to run without explicit: true and makes no calls', async () => {
  const { fetchFn, calls } = mockFetch([repoRoute]);
  const gh = client(fetchFn);
  await assert.rejects(gh.mergePR('run1', { prNumber: 7, explicit: false as any }), GitHubError);
  await assert.rejects(gh.mergePR('run1', { prNumber: 7, explicit: 'yes' as any }), GitHubError);
  assert.equal(calls.length, 0);
});

test('mergePR merges only a same-repo PR from the run branch', async () => {
  const { fetchFn, calls } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/pulls/7'
      ? { status: 200, json: { head: { ref: 'workflwpro/run1', repo: { full_name: 'acme/app' } } } }
      : undefined),
    (c) => (c.method === 'PUT' && c.url === '/repos/acme/app/pulls/7/merge'
      ? { status: 200, json: { merged: true, sha: 'merge-sha' } }
      : undefined),
  ]);
  const res = await client(fetchFn).mergePR('run1', { prNumber: 7, explicit: true });
  assert.deepEqual(res, { merged: true, sha: 'merge-sha' });
  assert.equal(calls.find((c) => c.method === 'PUT')?.body.merge_method, 'squash');
});

test('mergePR rejects a PR from another branch or a fork', async () => {
  const { fetchFn, calls } = mockFetch([
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/pulls/8'
      ? { status: 200, json: { head: { ref: 'main', repo: { full_name: 'acme/app' } } } }
      : undefined),
    (c) => (c.method === 'GET' && c.url === '/repos/acme/app/pulls/9'
      ? { status: 200, json: { head: { ref: 'workflwpro/run1', repo: { full_name: 'mallory/app' } } } }
      : undefined),
  ]);
  const gh = client(fetchFn);
  await assert.rejects(gh.mergePR('run1', { prNumber: 8, explicit: true }), PathPolicyError);
  await assert.rejects(gh.mergePR('run1', { prNumber: 9, explicit: true }), PathPolicyError);
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('no operation ever issues DELETE or PATCH', async () => {
  const { fetchFn, calls } = mockFetch([
    repoRoute,
    mainRefRoute,
    (c) => (c.method === 'GET' && c.url.includes('/git/ref/heads/workflwpro/run1')
      ? { status: 200, json: { object: { sha: 'x' } } }
      : undefined),
    (c) => (c.method === 'GET' && c.url.includes('/contents')
      ? { status: 200, json: [] }
      : undefined),
    (c) => (c.method === 'PUT' && c.url.includes('/contents')
      ? { status: 200, json: { content: { sha: 's' }, commit: { sha: 'c' } } }
      : undefined),
  ]);
  const gh = client(fetchFn);
  await gh.listFiles('run1');
  await gh.writeFile('run1', 'a.txt', 'x');
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET' && c.method !== 'POST' && c.method !== 'PUT'), []);
});
