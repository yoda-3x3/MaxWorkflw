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
let dispatched: Array<{ url: string; authorization: string | null }>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  saved = {
    CRON_SECRET: process.env.CRON_SECRET,
    SESSION_SECRET: process.env.SESSION_SECRET,
    ALLOWED_USERS: process.env.ALLOWED_USERS,
  };
  process.env.CRON_SECRET = SECRET;
  process.env.SESSION_SECRET = SESSION_SECRET_VALUE;
  process.env.ALLOWED_USERS = alice;

  // Mocked dispatch: records every kick instead of calling the step route.
  dispatched = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    dispatched.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
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
  test("the exact bearer kicks each active run by id with the cron secret", async () => {
    const a = `run-${Math.random().toString(36).slice(2)}`;
    const b = `run-${Math.random().toString(36).slice(2)}`;
    await getRunStore().saveRun(run("running", a));
    await getRunStore().saveRun(run("waiting_approval", b));

    const res = await cronKick(cronGet({ authorization: `Bearer ${SECRET}` }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { kicked: number };
    assert.ok(body.kicked >= 2);

    const urls = dispatched.map((d) => d.url);
    assert.ok(urls.includes(`https://app.test/api/runs/${a}/step`), "run a kicked");
    assert.ok(urls.includes(`https://app.test/api/runs/${b}/step`), "run b kicked");
    for (const d of dispatched) assert.equal(d.authorization, `Bearer ${SECRET}`);
  });

  test("a terminal run is not kicked", async () => {
    const done = `run-${Math.random().toString(36).slice(2)}`;
    await getRunStore().saveRun(run("done", done));
    await cronKick(cronGet({ authorization: `Bearer ${SECRET}` }));
    assert.ok(!dispatched.some((d) => d.url.includes(`/api/runs/${done}/`)));
  });
});
