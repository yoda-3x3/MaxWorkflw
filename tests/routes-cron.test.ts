import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { getRunStore } from "@/lib/store";
import type { Run } from "@/lib/types";
import { GET as cronKick } from "@/app/api/cron/kick/route";
import { POST as userKick } from "@/app/api/runs/[id]/kick/route";

const SECRET = "test-cron-secret-value";
const SESSION_SECRET_VALUE = "test-session-secret-0123456789abcdef";
const alice = "alice@example.com";

let saved: Record<string, string | undefined>;
// Mocked dispatch: every outbound fetch is recorded, never sent. Dispatch (GitHub workflow_dispatch
// via dispatchRun, or a kick) carries the run id in the URL or the body.
let dispatched: Array<{ url: string; authorization: string | null; body: string }>;
const realFetch = globalThis.fetch;

function dispatchedFor(runId: string) {
  return dispatched.filter((d) => d.url.includes(runId) || d.body.includes(runId));
}

beforeEach(() => {
  saved = {
    CRON_SECRET: process.env.CRON_SECRET,
    SESSION_SECRET: process.env.SESSION_SECRET,
    ALLOWED_USERS: process.env.ALLOWED_USERS,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  process.env.CRON_SECRET = SECRET;
  process.env.SESSION_SECRET = SESSION_SECRET_VALUE;
  process.env.ALLOWED_USERS = alice;
  process.env.GITHUB_TOKEN = "test-github-token";

  dispatched = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    dispatched.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function run(status: Run["status"], id: string): Run {
  return {
    id,
    ownerId: `email:${alice}`,
    task: "t",
    status,
    tokens: 0,
    agents: [],
    approvals: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 2,
  };
}

function cronGet(headers: Record<string, string> = {}, url = "https://app.test/api/cron/kick"): Request {
  return new Request(url, { method: "GET", headers });
}

describe("cron kick: auth", () => {
  test("no Authorization header gets 401 and dispatches nothing", async () => {
    const res = await cronKick(cronGet());
    assert.equal(res.status, 401);
    assert.deepEqual(dispatched, []);
  });

  test("a wrong secret of the same length gets 401", async () => {
    const res = await cronKick(cronGet({ authorization: `Bearer ${"x".repeat(SECRET.length)}` }));
    assert.equal(res.status, 401);
    assert.deepEqual(dispatched, []);
  });

  test("an empty CRON_SECRET denies even an empty bearer", async () => {
    process.env.CRON_SECRET = "";
    const res = await cronKick(cronGet({ authorization: "Bearer " }));
    assert.equal(res.status, 401);
    assert.deepEqual(dispatched, []);
  });

  test("an unset CRON_SECRET denies even an empty bearer", async () => {
    delete process.env.CRON_SECRET;
    const res = await cronKick(cronGet({ authorization: "Bearer " }));
    assert.equal(res.status, 401);
    assert.deepEqual(dispatched, []);
  });

  test("a user session cookie alone gets 401", async () => {
    const token = await createSession({ method: "magic_link", email: alice }, SESSION_SECRET_VALUE);
    const res = await cronKick(cronGet({ cookie: `${SESSION_COOKIE}=${token}` }));
    assert.equal(res.status, 401);
  });

  test("the cron secret is not accepted on a user route (wrong path) and gets 401", async () => {
    const seeded = `run-${Math.random().toString(36).slice(2)}`;
    await getRunStore().saveRun(run("running", seeded));
    const res = await userKick(
      new Request(`https://app.test/api/runs/${seeded}/kick`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      { params: Promise.resolve({ id: seeded }) },
    );
    assert.equal(res.status, 401);
    assert.deepEqual(dispatched, []);
  });
});

describe("cron kick: dispatch", () => {
  test("the exact bearer re-kicks each active run by id", async () => {
    const a = `run-${Math.random().toString(36).slice(2)}`;
    const b = `run-${Math.random().toString(36).slice(2)}`;
    await getRunStore().saveRun(run("running", a));
    await getRunStore().saveRun(run("waiting_approval", b));

    const res = await cronKick(cronGet({ authorization: `Bearer ${SECRET}` }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { kicked: number };
    assert.ok(body.kicked >= 2);

    // The dispatch runs after the response; let the queued task settle.
    await new Promise((r) => setImmediate(r));
    assert.ok(dispatchedFor(a).length >= 1, "run a dispatched");
    assert.ok(dispatchedFor(b).length >= 1, "run b dispatched");
  });

  test("a terminal run is not kicked", async () => {
    const done = `run-${Math.random().toString(36).slice(2)}`;
    await getRunStore().saveRun(run("done", done));
    await cronKick(cronGet({ authorization: `Bearer ${SECRET}` }));
    await new Promise((r) => setImmediate(r));
    assert.equal(dispatchedFor(done).length, 0);
  });
});
