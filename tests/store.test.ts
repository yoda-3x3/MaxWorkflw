import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backendFromEnv,
  createMemoryBackend,
  createRunStore,
  createUpstashBackend,
} from "../lib/store";
import type { ApprovalDecision, Run } from "../lib/types";

function makeRun(overrides: Partial<Run> & Pick<Run, "id" | "ownerId">): Run {
  return {
    task: "task",
    status: "queued",
    tokens: 0,
    agents: [],
    approvals: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 1 + 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function makeDecision(runId: string, id: string): ApprovalDecision {
  return { id, runId, approvalId: `ap-${id}`, decision: "approved", decidedAt: 1 };
}

test("getRun returns the run only to its owner", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.saveRun(makeRun({ id: "r1", ownerId: "alice@example.com" }));

  assert.equal((await store.getRun("alice@example.com", "r1"))?.id, "r1");
  assert.equal(await store.getRun("bob@example.com", "r1"), null);
  assert.equal(await store.getRun("alice@example.com", "missing"), null);
});

test("getRunForEngine reads any run without an owner check", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.saveRun(makeRun({ id: "r1", ownerId: "alice@example.com" }));

  assert.equal((await store.getRunForEngine("r1"))?.ownerId, "alice@example.com");
  assert.equal(await store.getRunForEngine("missing"), null);
});

test("listRunsForOwner returns only the owner's runs, newest first", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.saveRun(makeRun({ id: "a-old", ownerId: "alice", createdAt: 10, updatedAt: 10 }));
  await store.saveRun(makeRun({ id: "a-new", ownerId: "alice", createdAt: 30, updatedAt: 30 }));
  await store.saveRun(makeRun({ id: "b-1", ownerId: "bob", createdAt: 20, updatedAt: 20 }));

  const alice = await store.listRunsForOwner("alice");
  assert.deepEqual(
    alice.map((r) => r.id),
    ["a-new", "a-old"],
  );
  assert.equal(alice[0].task, "task");
  assert.equal(alice[0].updatedAt, 30);
  assert.deepEqual(await store.listRunsForOwner("carol"), []);
});

test("listRunsForOwner respects limit", async () => {
  const store = createRunStore(createMemoryBackend());
  for (let i = 1; i <= 5; i++) {
    await store.saveRun(makeRun({ id: `r${i}`, ownerId: "alice", createdAt: i, updatedAt: i }));
  }
  const ids = (await store.listRunsForOwner("alice", 2)).map((r) => r.id);
  assert.deepEqual(ids, ["r5", "r4"]);
});

test("listActiveRunIds excludes done and failed runs and follows status changes", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.saveRun(makeRun({ id: "run-a", ownerId: "alice", status: "running", updatedAt: 1 }));
  await store.saveRun(makeRun({ id: "run-b", ownerId: "alice", status: "waiting_approval", updatedAt: 2 }));
  await store.saveRun(makeRun({ id: "run-c", ownerId: "alice", status: "done", updatedAt: 3 }));

  assert.deepEqual((await store.listActiveRunIds()).sort(), ["run-a", "run-b"]);

  await store.saveRun(makeRun({ id: "run-a", ownerId: "alice", status: "failed", updatedAt: 4 }));
  assert.deepEqual(await store.listActiveRunIds(), ["run-b"]);
});

test("acquireRunLock is exclusive until released", async () => {
  const store = createRunStore(createMemoryBackend());

  const token = await store.acquireRunLock("r1", 60);
  assert.ok(token);
  assert.equal(await store.acquireRunLock("r1", 60), null);

  assert.equal(await store.releaseRunLock("r1", "not-the-holder"), false);
  assert.equal(await store.acquireRunLock("r1", 60), null);

  assert.equal(await store.releaseRunLock("r1", token), true);
  assert.ok(await store.acquireRunLock("r1", 60));
});

test("acquireRunLock returns a fresh token each time it is granted", async () => {
  const store = createRunStore(createMemoryBackend());
  const first = await store.acquireRunLock("r1", 60);
  assert.ok(first);
  await store.releaseRunLock("r1", first);
  const second = await store.acquireRunLock("r1", 60);
  assert.ok(second);
  assert.notEqual(first, second);
});

test("memory locks expire after their ttl", async () => {
  let clock = 1_000;
  const store = createRunStore(createMemoryBackend(() => clock));

  assert.ok(await store.acquireRunLock("r1", 5));
  clock += 4_999;
  assert.equal(await store.acquireRunLock("r1", 5), null);
  clock += 1;
  assert.ok(await store.acquireRunLock("r1", 5));
});

test("decisions are queued per run and drained oldest first, in batches", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.enqueueDecision("r1", makeDecision("r1", "d1"));
  await store.enqueueDecision("r1", makeDecision("r1", "d2"));
  await store.enqueueDecision("r1", makeDecision("r1", "d3"));
  await store.enqueueDecision("r2", makeDecision("r2", "other"));

  const first = await store.drainDecisions("r1", 2);
  assert.deepEqual(
    first.map((d) => d.id),
    ["d1", "d2"],
  );

  const rest = await store.drainDecisions("r1");
  assert.deepEqual(
    rest.map((d) => d.id),
    ["d3"],
  );
  assert.deepEqual(await store.drainDecisions("r1"), []);
  assert.deepEqual(
    (await store.drainDecisions("r2")).map((d) => d.id),
    ["other"],
  );
});

test("enqueueDecision rejects a decision addressed to another run", async () => {
  const store = createRunStore(createMemoryBackend());
  await assert.rejects(store.enqueueDecision("r1", makeDecision("r2", "d1")), /mismatch/);
});

test("run ids are validated before touching storage", async () => {
  const store = createRunStore(createMemoryBackend());
  await assert.rejects(store.getRunForEngine("../etc"), /invalid run id/);
  await assert.rejects(store.acquireRunLock("a b", 60), /invalid run id/);
  await assert.rejects(store.drainDecisions(""), /invalid run id/);
  await assert.rejects(store.saveRun(makeRun({ id: "x/y", ownerId: "alice" })), /invalid run id/);
});

test("upstash backend sends REST commands and reads results", async () => {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, auth: headers.Authorization, body: JSON.parse(String(init.body)) });
    const last = calls[calls.length - 1].body as string[];
    const result = last[0] === "SET" && last.includes("NX") ? "OK" : last[0] === "GET" ? "hello" : 1;
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;

  const kv = createUpstashBackend("https://db.example.upstash.io/", "tok", fakeFetch);

  assert.equal(await kv.get("k"), "hello");
  assert.equal(await kv.setNxEx("lock", "v", 60), true);
  assert.equal(calls[0].url, "https://db.example.upstash.io");
  assert.equal(calls[0].auth, "Bearer tok");
  assert.deepEqual(calls[1].body, ["SET", "lock", "v", "NX", "EX", "60"]);
  assert.deepEqual(calls[0].body, ["GET", "k"]);
});

test("upstash setNxEx returns false when the key already exists", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ result: null }), { status: 200 })) as typeof fetch;
  const kv = createUpstashBackend("https://db.example.upstash.io", "tok", fakeFetch);
  assert.equal(await kv.setNxEx("lock", "v", 60), false);
});

test("upstash backend throws on an error reply or HTTP failure", async () => {
  const errorReply = (async () =>
    new Response(JSON.stringify({ error: "WRONGTYPE" }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    createUpstashBackend("https://db", "tok", errorReply).get("k"),
    /WRONGTYPE/,
  );

  const httpFail = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(createUpstashBackend("https://db", "tok", httpFail).get("k"), /401/);
});

test("upstash drainDecisions maps a null LPOP reply to an empty list", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ result: null }), { status: 200 })) as typeof fetch;
  const kv = createUpstashBackend("https://db", "tok", fakeFetch);
  const store = createRunStore(kv);
  assert.deepEqual(await store.drainDecisions("r1"), []);
});

test("backendFromEnv uses memory outside production when unconfigured", async () => {
  const kv = backendFromEnv({ NODE_ENV: "development" });
  await kv.set("k", "v");
  assert.equal(await kv.get("k"), "v");
});

test("backendFromEnv refuses to fall back to memory in production", () => {
  assert.throws(() => backendFromEnv({ NODE_ENV: "production" }), /required in production/);
});

test("backendFromEnv uses Upstash when both env vars are set", async () => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }) as typeof fetch;
  try {
    const kv = backendFromEnv({
      NODE_ENV: "production",
      UPSTASH_REDIS_REST_URL: "https://db.example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    assert.equal(await kv.get("k"), null);
    assert.deepEqual(seen, ["https://db.example.upstash.io"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a stale holder cannot release a lock that expired and was taken over", async () => {
  let clock = 1_000;
  const store = createRunStore(createMemoryBackend(() => clock));
  const stale = await store.acquireRunLock("r1", 60);
  assert.ok(stale);
  clock += 61_000;
  const fresh = await store.acquireRunLock("r1", 60);
  assert.ok(fresh, "expired lock is free to take");

  assert.equal(await store.releaseRunLock("r1", stale), false);
  assert.equal(await store.acquireRunLock("r1", 60), null, "the new holder still holds the lock");
  assert.equal(await store.releaseRunLock("r1", fresh), true);
});
