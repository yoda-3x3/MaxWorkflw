import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchRunWorkflow,
  getDispatchConfig,
  BRANCH_PREFIX,
  GitHubError,
  PathPolicyError,
} from '../lib/github';

type Seen = { url: string; method: string; headers: Record<string, string>; body: any };

// Fake fetch that records each call and answers with the given status.
function fakeFetch(status: number, json?: unknown) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string>) };
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(json === undefined ? null : JSON.stringify(json), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const DISPATCH_URL = 'https://api.github.com/repos/acme/app/actions/workflows/run.yml/dispatches';

test('dispatchRunWorkflow POSTs ref and run_id to the workflow dispatches endpoint', async () => {
  const { fetchFn, seen } = fakeFetch(204);
  const result = await dispatchRunWorkflow({
    repo: 'acme/app',
    token: 'tok',
    runId: 'run-42',
    fetch: fetchFn,
  });
  assert.equal(result, undefined);
  assert.equal(seen.length, 1);
  const [call] = seen;
  assert.equal(call.url, DISPATCH_URL);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer tok');
  assert.deepEqual(call.body, { ref: 'main', inputs: { run_id: 'run-42' } });
});

test('dispatchRunWorkflow uses the given workflow and ref', async () => {
  const { fetchFn, seen } = fakeFetch(204);
  await dispatchRunWorkflow({
    repo: 'acme/app',
    token: 'tok',
    workflow: 'deploy.yml',
    ref: 'release',
    runId: 'run1',
    fetch: fetchFn,
  });
  assert.equal(seen[0].url, 'https://api.github.com/repos/acme/app/actions/workflows/deploy.yml/dispatches');
  assert.deepEqual(seen[0].body, { ref: 'release', inputs: { run_id: 'run1' } });
});

test('dispatchRunWorkflow rejects an invalid run id before any network call', async () => {
  const { fetchFn, seen } = fakeFetch(204);
  for (const id of ['', '../main', 'a/b', 'a..b', 'run.', 'a\nb']) {
    await assert.rejects(
      dispatchRunWorkflow({ repo: 'acme/app', token: 'tok', runId: id, fetch: fetchFn }),
      PathPolicyError,
    );
  }
  assert.equal(seen.length, 0);
});

test('dispatchRunWorkflow rejects a malformed repo before any network call', async () => {
  const { fetchFn, seen } = fakeFetch(204);
  for (const repo of ['', 'acme', '/app', 'acme/', 'a/b/c']) {
    await assert.rejects(
      dispatchRunWorkflow({ repo, token: 'tok', runId: 'run1', fetch: fetchFn }),
      (err: unknown) => err instanceof GitHubError && err.status === 400,
    );
  }
  assert.equal(seen.length, 0);
});

test('dispatchRunWorkflow maps 404 to a hint about the workflow or repo', async () => {
  const { fetchFn } = fakeFetch(404, { message: 'Not Found' });
  await assert.rejects(
    dispatchRunWorkflow({ repo: 'acme/app', token: 'tok', runId: 'run1', fetch: fetchFn }),
    (err: unknown) => err instanceof GitHubError
      && err.status === 404
      && /DISPATCH_WORKFLOW/.test(err.message)
      && /Not Found/.test(err.message),
  );
});

test('dispatchRunWorkflow maps 403 to a hint about Actions permission', async () => {
  const { fetchFn } = fakeFetch(403, { message: 'Resource not accessible' });
  await assert.rejects(
    dispatchRunWorkflow({ repo: 'acme/app', token: 'tok', runId: 'run1', fetch: fetchFn }),
    (err: unknown) => err instanceof GitHubError
      && err.status === 403
      && /Actions: write/.test(err.message),
  );
});

test('dispatchRunWorkflow maps 422 to a hint about ref and workflow_dispatch', async () => {
  const { fetchFn } = fakeFetch(422, { message: 'No ref found for: nope' });
  await assert.rejects(
    dispatchRunWorkflow({ repo: 'acme/app', token: 'tok', runId: 'run1', ref: 'nope', fetch: fetchFn }),
    (err: unknown) => err instanceof GitHubError
      && err.status === 422
      && /workflow_dispatch/.test(err.message)
      && /"nope"/.test(err.message),
  );
});

test('dispatchRunWorkflow passes other errors through with their status', async () => {
  const { fetchFn } = fakeFetch(500, { message: 'boom' });
  await assert.rejects(
    dispatchRunWorkflow({ repo: 'acme/app', token: 'tok', runId: 'run1', fetch: fetchFn }),
    (err: unknown) => err instanceof GitHubError && err.status === 500 && /boom/.test(err.message),
  );
});

test('dispatchRunWorkflow reports a timeout as GitHubError 408', async () => {
  const fetchFn = (async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  }) as typeof fetch;
  await assert.rejects(
    dispatchRunWorkflow({ repo: 'acme/app', token: 'tok', runId: 'run1', fetch: fetchFn }),
    (err: unknown) => err instanceof GitHubError && err.status === 408 && /timed out/.test(err.message),
  );
});

test('dispatchRunWorkflow lets unrelated network errors through unchanged', async () => {
  const fetchFn = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(
    dispatchRunWorkflow({ repo: 'acme/app', token: 'tok', runId: 'run1', fetch: fetchFn }),
    TypeError,
  );
});

test('getDispatchConfig returns defaults when the environment is empty', () => {
  assert.deepEqual(getDispatchConfig({}), {
    token: undefined,
    repo: 'yoda-3x3/MaxWorkflw',
    workflow: 'run.yml',
    ref: 'main',
  });
});

test('getDispatchConfig reads each value from the environment', () => {
  assert.deepEqual(
    getDispatchConfig({
      GITHUB_TOKEN: 'ghp_x',
      DISPATCH_REPO: 'acme/other',
      DISPATCH_WORKFLOW: 'deploy.yml',
      DISPATCH_REF: 'release',
    }),
    { token: 'ghp_x', repo: 'acme/other', workflow: 'deploy.yml', ref: 'release' },
  );
});

test('getDispatchConfig treats an empty or blank GITHUB_TOKEN as missing', () => {
  assert.equal(getDispatchConfig({ GITHUB_TOKEN: '' }).token, undefined);
  assert.equal(getDispatchConfig({ GITHUB_TOKEN: '   ' }).token, undefined);
});

test('branch prefix is workflwpro/', () => {
  assert.equal(BRANCH_PREFIX, 'workflwpro/');
});
