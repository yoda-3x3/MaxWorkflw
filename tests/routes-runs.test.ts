import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { getRunStore } from "@/lib/store";
import type { Approval, Run } from "@/lib/types";
import { GET as listRuns, POST as createRunRoute } from "@/app/api/runs/route";
import { GET as getRun } from "@/app/api/runs/[id]/route";
import { GET as readEvents } from "@/app/api/runs/[id]/events/route";
import { POST as decide } from "@/app/api/runs/[id]/approvals/[approvalId]/route";
import { POST as merge } from "@/app/api/runs/[id]/merge/route";
import { GET as runnerStatus } from "@/app/api/runner/status/route";

const SESSION_SECRET_VALUE = "test-session-secret-0123456789abcdef";
const alice = "alice";
// Owner key comes from auth: `github:<login>`. Sessions are GitHub-only and login-allowlisted.
const aliceId = `github:${alice}`;

let saved: Record<string, string | undefined>;
// Mocked GitHub: merge reaches GitHub through global fetch. Every call is recorded and never sent.
let outbound: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  // getRunStore() caches one in-memory store on globalThis. Drop it so each test starts empty.
  delete (globalThis as Record<string, unknown>).__maxworkflwRunStore;
  saved = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    ALLOWED_USERS: process.env.ALLOWED_USERS,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  process.env.SESSION_SECRET = SESSION_SECRET_VALUE;
  process.env.ALLOWED_USERS = `${alice},bob`;
  process.env.GITHUB_TOKEN = "test-github-token";

  outbound = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    outbound.push(String(input));
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function cookieFor(login: string) {
  const token = await createSession({ method: "github", login }, SESSION_SECRET_VALUE);
  return `${SESSION_COOKIE}=${token}`;
}

const aliceCookie = () => cookieFor(alice);
const bobCookie = () => cookieFor("bob");

function approval(id: string, runId: string, status: Approval["status"]): Approval {
  return {
    id,
    runId,
    agentId: "a1",
    kind: "production_deploy",
    request: "deploy to prod",
    status,
    createdAt: 1,
  };
}

async function seedRun(overrides: Partial<Run> = {}): Promise<string> {
  const id = `run-${Math.random().toString(36).slice(2)}`;
  const run: Run = {
    id,
    ownerId: aliceId,
    task: "t",
    status: "waiting_approval",
    tokens: 0,
    agents: [],
    approvals: [approval(`${id}-pending`, id, "pending"), approval(`${id}-done`, id, "approved")],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 2,
    ...overrides,
  };
  await getRunStore().saveRun(run);
  return id;
}

function req(method: string, url: string, cookie: string | undefined, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("run ownership", () => {
  test("the owner reads their run", async () => {
    const runId = await seedRun();
    const res = await getRun(req("GET", `https://app.test/api/runs/${runId}`, await aliceCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 200);
  });

  test("another allowed user gets 404, not the run", async () => {
    const runId = await seedRun();
    const res = await getRun(req("GET", `https://app.test/api/runs/${runId}`, await bobCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 404);
  });

  test("no session gets 401", async () => {
    const runId = await seedRun();
    const res = await getRun(req("GET", `https://app.test/api/runs/${runId}`, undefined), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 401);
  });

  test("a session for a user no longer on the allowlist gets 401", async () => {
    const runId = await seedRun();
    process.env.ALLOWED_USERS = "someone-else";
    const res = await getRun(req("GET", `https://app.test/api/runs/${runId}`, await aliceCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 401);
  });
});

describe("starting runs", () => {
  test("an allowed user's POST saves the run and queues it for the runner", async () => {
    const res = await createRunRoute(req("POST", "https://app.test/api/runs", await aliceCookie(), { task: "  ship it  " }));
    assert.equal(res.status, 201);
    const run = (await res.json()) as Run;
    assert.equal(run.task, "ship it");
    assert.equal(run.ownerId, aliceId);
    assert.equal(run.status, "queued");

    assert.deepEqual(await getRunStore().popRuns(10), [run.id]);
    assert.equal((await getRunStore().getRun(aliceId, run.id))?.id, run.id);
  });

  test("a user off the allowlist cannot start a run and nothing is queued", async () => {
    process.env.ALLOWED_USERS = "someone-else";
    const res = await createRunRoute(req("POST", "https://app.test/api/runs", await aliceCookie(), { task: "x" }));
    assert.equal(res.status, 401);
    assert.deepEqual(await getRunStore().popRuns(10), []);
  });

  test("an empty task gets 400 and nothing is queued", async () => {
    const res = await createRunRoute(req("POST", "https://app.test/api/runs", await aliceCookie(), { task: "   " }));
    assert.equal(res.status, 400);
    assert.deepEqual(await getRunStore().popRuns(10), []);
  });

  test("a repo that is not owner/name gets 400", async () => {
    const res = await createRunRoute(req("POST", "https://app.test/api/runs", await aliceCookie(), { task: "x", repo: "nope" }));
    assert.equal(res.status, 400);
  });

  test("GET lists the caller's runs with the runner's online state", async () => {
    const runId = await seedRun();
    const res = await listRuns(req("GET", "https://app.test/api/runs", await aliceCookie()));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runs: { id: string }[]; runner: { online: boolean } };
    assert.ok(body.runs.some((r) => r.id === runId));
    assert.deepEqual(body.runner, { online: false });

    await getRunStore().heartbeat({ runnerId: "pc", pid: 1, host: "h", startedAt: 1, ts: Date.now() });
    const after = (await (await listRuns(req("GET", "https://app.test/api/runs", await aliceCookie()))).json()) as {
      runner: { online: boolean };
    };
    assert.equal(after.runner.online, true);
  });
});

describe("runner status", () => {
  test("reports offline with no heartbeat, online after one", async () => {
    const offline = await runnerStatus(req("GET", "https://app.test/api/runner/status", await aliceCookie()));
    assert.deepEqual(await offline.json(), { online: false });

    await getRunStore().heartbeat({ runnerId: "pc-9", pid: 7, host: "DESK", startedAt: 5, ts: 6 });
    const online = await runnerStatus(req("GET", "https://app.test/api/runner/status", await aliceCookie()));
    assert.deepEqual(await online.json(), { online: true, runnerId: "pc-9", host: "DESK", startedAt: 5, lastSeen: 6 });
  });

  test("requires a session", async () => {
    const res = await runnerStatus(req("GET", "https://app.test/api/runner/status", undefined));
    assert.equal(res.status, 401);
  });
});

describe("progress events", () => {
  test("the owner pages through events from the runner", async () => {
    const runId = await seedRun();
    await getRunStore().appendProgress(runId, [
      { at: 1, message: "Planning" },
      { at: 2, message: "Wave: 2 agent(s)" },
    ]);
    const first = await readEvents(
      req("GET", `https://app.test/api/runs/${runId}/events?from=0`, await aliceCookie()),
      { params: Promise.resolve({ id: runId }) },
    );
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      events: [
        { at: 1, message: "Planning" },
        { at: 2, message: "Wave: 2 agent(s)" },
      ],
      next: 2,
    });

    const next = await readEvents(
      req("GET", `https://app.test/api/runs/${runId}/events?from=2`, await aliceCookie()),
      { params: Promise.resolve({ id: runId }) },
    );
    assert.deepEqual(await next.json(), { events: [], next: 2 });
  });

  test("another user gets 404 for the events", async () => {
    const runId = await seedRun();
    const res = await readEvents(req("GET", `https://app.test/api/runs/${runId}/events`, await bobCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 404);
  });
});

describe("approval decide", () => {
  const url = (runId: string, approvalId: string) => `https://app.test/api/runs/${runId}/approvals/${approvalId}`;

  test("another user gets 404 and no decision is queued", async () => {
    const runId = await seedRun();
    const res = await decide(req("POST", url(runId, `${runId}-pending`), await bobCookie(), { decision: "approve" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await getRunStore().drainDecisions(runId, 10), []);
    assert.deepEqual(await getRunStore().popRuns(10), []);
  });

  test("an already decided approval gets 409", async () => {
    const runId = await seedRun();
    const res = await decide(req("POST", url(runId, `${runId}-done`), await aliceCookie(), { decision: "deny" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-done` }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await getRunStore().drainDecisions(runId, 10), []);
  });

  test("an unknown approval gets 404", async () => {
    const runId = await seedRun();
    const res = await decide(req("POST", url(runId, "nope"), await aliceCookie(), { decision: "approve" }), {
      params: Promise.resolve({ id: runId, approvalId: "nope" }),
    });
    assert.equal(res.status, 404);
  });

  test("a bad decision value gets 400", async () => {
    const runId = await seedRun();
    const res = await decide(req("POST", url(runId, `${runId}-pending`), await aliceCookie(), { decision: "maybe" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }),
    });
    assert.equal(res.status, 400);
  });

  test("the owner's approve is queued as 'approved', the run is queued, and the approval is untouched", async () => {
    const runId = await seedRun();
    const res = await decide(
      req("POST", url(runId, `${runId}-pending`), await aliceCookie(), { decision: "approve", note: "  go  " }),
      { params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }) },
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await getRunStore().popRuns(10), [runId]);

    const [queued] = await getRunStore().drainDecisions(runId, 10);
    assert.equal(queued.approvalId, `${runId}-pending`);
    assert.equal(queued.runId, runId);
    assert.equal(queued.decision, "approved");
    assert.equal(queued.note, "go");
    assert.equal(typeof queued.id, "string");
    assert.equal(typeof queued.decidedAt, "number");

    const run = await getRunStore().getRun(aliceId, runId);
    assert.equal(run?.approvals.find((a) => a.id === `${runId}-pending`)?.status, "pending");
  });

  test("deny is queued as 'denied'", async () => {
    const runId = await seedRun();
    const res = await decide(req("POST", url(runId, `${runId}-pending`), await aliceCookie(), { decision: "deny" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }),
    });
    assert.equal(res.status, 202);
    const [queued] = await getRunStore().drainDecisions(runId, 10);
    assert.equal(queued.decision, "denied");
  });
});

describe("merge", () => {
  const withPr = { repo: "octo/app", prNumber: 7, prUrl: "https://github.com/octo/app/pull/7" };
  const url = (runId: string) => `https://app.test/api/runs/${runId}/merge`;

  test("without confirm: true gets 400", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(req("POST", url(runId), await aliceCookie(), {}), { params: Promise.resolve({ id: runId }) });
    assert.equal(res.status, 400);
  });

  test("confirm must be exactly true", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(req("POST", url(runId), await aliceCookie(), { confirm: "yes" }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 400);
  });

  test("a non-owner gets 404 even with confirm: true", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(req("POST", url(runId), await bobCookie(), { confirm: true }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(outbound, []);
  });

  test("confirm: false gets 400", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(req("POST", url(runId), await aliceCookie(), { confirm: false }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 400);
  });

  test("the owner with confirm but no PR gets 409", async () => {
    const runId = await seedRun();
    const res = await merge(req("POST", url(runId), await aliceCookie(), { confirm: true }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 409);
  });
});
