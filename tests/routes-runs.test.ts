import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { getRunStore } from "@/lib/store";
import type { Approval, Run } from "@/lib/types";
import { GET as getRun } from "@/app/api/runs/[id]/route";
import { POST as kickRun } from "@/app/api/runs/[id]/kick/route";
import { POST as decide } from "@/app/api/runs/[id]/approvals/[approvalId]/route";
import { POST as merge } from "@/app/api/runs/[id]/merge/route";

const SESSION_SECRET_VALUE = "test-session-secret-0123456789abcdef";
const alice = "alice";
// Owner key comes from auth: `github:<login>`. Sessions are GitHub-only and login-allowlisted.
const aliceId = `github:${alice}`;

const CRON_SECRET_VALUE = "test-cron-secret-value";

let saved: Record<string, string | undefined>;
// Mocked dispatch: dispatchRun reaches GitHub through global fetch (workflow_dispatch with
// inputs.run_id). Every outbound call is recorded and never sent.
let dispatched: Array<{ url: string; authorization: string | null; body: string }>;
const realFetch = globalThis.fetch;

/** Dispatch calls that carry this run id (URL or body). */
function dispatchedFor(runId: string) {
  return dispatched.filter((d) => d.url.includes(runId) || d.body.includes(runId));
}

/** dispatchRun starts after the response (after() runs inline in tests), so let it settle. */
async function settle(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  saved = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    ALLOWED_USERS: process.env.ALLOWED_USERS,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    CRON_SECRET: process.env.CRON_SECRET,
  };
  process.env.SESSION_SECRET = SESSION_SECRET_VALUE;
  process.env.ALLOWED_USERS = `${alice},bob`;
  process.env.CRON_SECRET = CRON_SECRET_VALUE;
  process.env.GITHUB_TOKEN = "test-github-token";

  dispatched = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    dispatched.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
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

function post(url: string, cookie: string | undefined, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("run ownership", () => {
  test("the owner reads their run", async () => {
    const runId = await seedRun();
    const res = await getRun(new Request(`https://app.test/api/runs/${runId}`, { headers: { cookie: await aliceCookie() } }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 200);
  });

  test("another allowed user gets 404, not the run", async () => {
    const runId = await seedRun();
    const res = await getRun(new Request(`https://app.test/api/runs/${runId}`, { headers: { cookie: await bobCookie() } }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 404);
  });

  test("no session gets 401", async () => {
    const runId = await seedRun();
    const res = await getRun(new Request(`https://app.test/api/runs/${runId}`), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 401);
  });

  test("a session for a user no longer on the allowlist gets 401", async () => {
    const runId = await seedRun();
    process.env.ALLOWED_USERS = "someone-else";
    const res = await getRun(new Request(`https://app.test/api/runs/${runId}`, { headers: { cookie: await aliceCookie() } }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 401);
  });

  test("kick is owner-only", async () => {
    const runId = await seedRun();
    const res = await kickRun(post(`https://app.test/api/runs/${runId}/kick`, await bobCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(dispatched, []);
  });

  test("the owner's kick of an active run stale for over 90s dispatches the run id", async () => {
    // seedRun sets updatedAt: 1, which is far older than 90s.
    const runId = await seedRun();
    const res = await kickRun(post(`https://app.test/api/runs/${runId}/kick`, await aliceCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { status: "waiting_approval", kicked: true });
    await settle();
    assert.equal(dispatchedFor(runId).length, 1);
  });

  test("a kick within 90s of the last update answers kicked:false and dispatches nothing", async () => {
    const runId = await seedRun({ updatedAt: Date.now() - 30_000 });
    const res = await kickRun(post(`https://app.test/api/runs/${runId}/kick`, await aliceCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "waiting_approval", kicked: false });
    await settle();
    assert.equal(dispatchedFor(runId).length, 0);
  });

  test("a kick just past 90s since the last update does dispatch", async () => {
    const runId = await seedRun({ updatedAt: Date.now() - 91_000 });
    const res = await kickRun(post(`https://app.test/api/runs/${runId}/kick`, await aliceCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 202);
    await settle();
    assert.equal(dispatchedFor(runId).length, 1);
  });

  test("the owner's kick of a finished run answers kicked:false and dispatches nothing", async () => {
    const runId = await seedRun({ status: "done" });
    const res = await kickRun(post(`https://app.test/api/runs/${runId}/kick`, await aliceCookie()), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "done", kicked: false });
    assert.deepEqual(dispatched, []);
  });

  test("the cron secret alone cannot kick a user route (wrong path) and gets 401", async () => {
    const runId = await seedRun();
    const res = await kickRun(
      new Request(`https://app.test/api/runs/${runId}/kick`, {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET_VALUE}` },
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    assert.equal(res.status, 401);
    assert.deepEqual(dispatched, []);
  });
});

describe("approval decide", () => {
  const url = (runId: string, approvalId: string) => `https://app.test/api/runs/${runId}/approvals/${approvalId}`;

  test("another user gets 404 and no decision is queued", async () => {
    const runId = await seedRun();
    const res = await decide(post(url(runId, `${runId}-pending`), await bobCookie(), { decision: "approve" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await getRunStore().drainDecisions(runId, 10), []);
  });

  test("an already decided approval gets 409", async () => {
    const runId = await seedRun();
    const res = await decide(post(url(runId, `${runId}-done`), await aliceCookie(), { decision: "deny" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-done` }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await getRunStore().drainDecisions(runId, 10), []);
  });

  test("an unknown approval gets 404", async () => {
    const runId = await seedRun();
    const res = await decide(post(url(runId, "nope"), await aliceCookie(), { decision: "approve" }), {
      params: Promise.resolve({ id: runId, approvalId: "nope" }),
    });
    assert.equal(res.status, 404);
  });

  test("a bad decision value gets 400", async () => {
    const runId = await seedRun();
    const res = await decide(post(url(runId, `${runId}-pending`), await aliceCookie(), { decision: "maybe" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }),
    });
    assert.equal(res.status, 400);
  });

  test("the owner's approve is queued as types.ts 'approved' and the approval is untouched", async () => {
    const runId = await seedRun();
    const res = await decide(
      post(url(runId, `${runId}-pending`), await aliceCookie(), { decision: "approve", note: "  go  " }),
      { params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }) },
    );
    assert.equal(res.status, 202);

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
    const res = await decide(post(url(runId, `${runId}-pending`), await aliceCookie(), { decision: "deny" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }),
    });
    assert.equal(res.status, 202);
    const [queued] = await getRunStore().drainDecisions(runId, 10);
    assert.equal(queued.decision, "denied");
  });

  test("the decision is enqueued before the step dispatch", async () => {
    const runId = await seedRun();
    const store = getRunStore();
    const order: string[] = [];
    const realEnqueue = store.enqueueDecision.bind(store);
    store.enqueueDecision = async (id, decision) => {
      order.push("enqueue");
      return realEnqueue(id, decision);
    };
    const realFetchStub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("/dispatches") && body.includes(runId)) order.push("dispatch");
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const res = await decide(post(url(runId, `${runId}-pending`), await aliceCookie(), { decision: "approve" }), {
        params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }),
      });
      assert.equal(res.status, 202);
      await settle();
      assert.deepEqual(order, ["enqueue", "dispatch"]);
    } finally {
      globalThis.fetch = realFetchStub;
      store.enqueueDecision = realEnqueue;
      await store.drainDecisions(runId, 10);
    }
  });

  test("a non-owner's decide dispatches nothing", async () => {
    const runId = await seedRun();
    await decide(post(url(runId, `${runId}-pending`), await bobCookie(), { decision: "approve" }), {
      params: Promise.resolve({ id: runId, approvalId: `${runId}-pending` }),
    });
    assert.deepEqual(dispatched, []);
  });
});

describe("merge", () => {
  const withPr = { repo: "octo/app", prNumber: 7, prUrl: "https://github.com/octo/app/pull/7" };
  const url = (runId: string) => `https://app.test/api/runs/${runId}/merge`;

  test("without confirm: true gets 400", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(post(url(runId), await aliceCookie(), {}), { params: Promise.resolve({ id: runId }) });
    assert.equal(res.status, 400);
  });

  test("confirm must be exactly true", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(post(url(runId), await aliceCookie(), { confirm: "yes" }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 400);
  });

  test("a non-owner gets 404 even with confirm: true", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(post(url(runId), await bobCookie(), { confirm: true }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 404);
  });

  test("confirm: false gets 400", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(post(url(runId), await aliceCookie(), { confirm: false }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 400);
  });

  test("the cron secret cannot merge (wrong path) and gets 401", async () => {
    const runId = await seedRun(withPr);
    const res = await merge(
      new Request(url(runId), {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET_VALUE}`, "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    assert.equal(res.status, 401);
  });

  test("the owner with confirm but no PR gets 409", async () => {
    const runId = await seedRun();
    const res = await merge(post(url(runId), await aliceCookie(), { confirm: true }), {
      params: Promise.resolve({ id: runId }),
    });
    assert.equal(res.status, 409);
  });
});
