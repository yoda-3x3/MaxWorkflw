import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEARTBEAT_TTL_SEC,
  PROGRESS_TTL_SEC,
  backendFromEnv,
  createMemoryBackend,
  createRunStore,
  createUpstashBackend,
} from "../lib/store";
import type { ApprovalDecision, Run, RunEvent, RunnerHeartbeat } from "../lib/types";

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

function makeHeartbeat(overrides: Partial<RunnerHeartbeat> = {}): RunnerHeartbeat {
  return { runnerId: "pc-1", pid: 42, host: "DESKTOP", startedAt: 100, ts: 200, ...overrides };
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

test("saveRun with queue true also queues the run id, in the same call", async () => {
  const kv = createMemoryBackend();
  const store = createRunStore(kv);
  await store.saveRun(makeRun({ id: "r1", ownerId: "alice" }), { queue: true });
  await store.saveRun(makeRun({ id: "r2", ownerId: "alice" }));

  assert.deepEqual(await store.popRuns(10), ["r1"]);
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

test("queueDecision stores the decision and queues the run in one call", async () => {
  const calls: unknown[][] = [];
  const kv = createMemoryBackend();
  const spy = {
    async pipeline(cmds: (string | number)[][]) {
      calls.push(cmds);
      return kv.pipeline(cmds);
    },
  };
  const store = createRunStore(spy);
  await store.queueDecision("r1", makeDecision("r1", "d1"));

  assert.equal(calls.length, 1, "one pipeline call");
  assert.equal((calls[0] as unknown[][])[1][0], "RPUSH");
  assert.deepEqual(await store.popRuns(), ["r1"]);
  assert.deepEqual((await store.drainDecisions("r1")).map((d) => d.id), ["d1"]);
});

test("enqueueDecision rejects a decision addressed to another run", async () => {
  const store = createRunStore(createMemoryBackend());
  await assert.rejects(store.enqueueDecision("r1", makeDecision("r2", "d1")), /mismatch/);
  await assert.rejects(store.queueDecision("r1", makeDecision("r2", "d1")), /mismatch/);
});

test("runner queue is FIFO and tolerates duplicates", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.enqueueRun("r1");
  await store.enqueueRun("r2");
  await store.enqueueRun("r1");

  assert.deepEqual(await store.popRuns(2), ["r1", "r2"]);
  assert.deepEqual(await store.popRuns(5), ["r1"]);
  assert.deepEqual(await store.popRuns(5), []);
});

test("claimRun is exclusive, and only the holder can release it", async () => {
  const store = createRunStore(createMemoryBackend());
  assert.equal(await store.claimRun("r1", "pc-1"), true);
  assert.equal(await store.claimRun("r1", "pc-2"), false);
  assert.equal(await store.releaseClaim("r1", "pc-2"), false);
  assert.equal(await store.claimRun("r1", "pc-2"), false);
  assert.equal(await store.releaseClaim("r1", "pc-1"), true);
  assert.equal(await store.claimRun("r1", "pc-2"), true);
});

test("claimRun expires after its ttl so a crashed runner does not hold a run", async () => {
  let clock = 0;
  const store = createRunStore(createMemoryBackend(() => clock));
  assert.equal(await store.claimRun("r1", "pc-1", 10), true);
  clock += 10_000;
  assert.equal(await store.claimRun("r1", "pc-2", 10), true);
});

test("appendProgress and readProgress page through events in order", async () => {
  const store = createRunStore(createMemoryBackend());
  const events: RunEvent[] = [
    { at: 1, message: "Planning" },
    { at: 2, agentId: "a1", message: "done" },
    { at: 3, message: "Run finished" },
  ];
  await store.appendProgress("r1", events.slice(0, 2));
  await store.appendProgress("r1", []);
  await store.appendProgress("r1", events.slice(2));

  const first = await store.readProgress("r1", 0, 2);
  assert.deepEqual(first.events, events.slice(0, 2));
  assert.equal(first.next, 2);

  const rest = await store.readProgress("r1", first.next);
  assert.deepEqual(rest.events, events.slice(2));
  assert.equal(rest.next, 3);

  assert.deepEqual(await store.readProgress("r-none"), { events: [], next: 0 });
});

test("runner heartbeat reports online until the TTL lapses, then offline", async () => {
  let clock = 1_000_000;
  const store = createRunStore(createMemoryBackend(() => clock));
  assert.deepEqual(await store.getRunnerStatus(), { online: false });

  await store.heartbeat(makeHeartbeat({ ts: clock }));
  assert.deepEqual(await store.getRunnerStatus(), {
    online: true,
    runnerId: "pc-1",
    host: "DESKTOP",
    startedAt: 100,
    lastSeen: clock,
  });

  clock += HEARTBEAT_TTL_SEC * 1000 - 1;
  assert.equal((await store.getRunnerStatus()).online, true);
  clock += 1;
  assert.deepEqual(await store.getRunnerStatus(), { online: false });
});

test("run ids are validated before touching storage", async () => {
  const store = createRunStore(createMemoryBackend());
  await assert.rejects(store.getRunForEngine("../etc"), /invalid run id/);
  await assert.rejects(store.acquireRunLock("a b", 60), /invalid run id/);
  await assert.rejects(store.drainDecisions(""), /invalid run id/);
  await assert.rejects(store.enqueueRun("x/y"), /invalid run id/);
  await assert.rejects(store.claimRun("", "pc-1"), /invalid run id/);
  await assert.rejects(store.saveRun(makeRun({ id: "x/y", ownerId: "alice" })), /invalid run id/);
});

test("popRuns drops ids that do not look like run ids", async () => {
  const kv = createMemoryBackend();
  await kv.pipeline([["RPUSH", "runner:queue", "good-1", "bad/id", "../x"]]);
  const store = createRunStore(kv);
  assert.deepEqual(await store.popRuns(5), ["good-1"]);
});

test("upstash backend posts each batch to /pipeline with one request", async () => {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body)) as string[][];
    calls.push({ url, auth: headers.Authorization, body });
    return new Response(JSON.stringify(body.map(() => ({ result: "OK" }))), { status: 200 });
  }) as typeof fetch;

  const kv = createUpstashBackend("https://db.example.upstash.io/", "tok", fakeFetch);
  const out = await kv.pipeline([
    ["SET", "k", "v"],
    ["EXPIRE", "k", 60],
  ]);

  assert.deepEqual(out, ["OK", "OK"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://db.example.upstash.io/pipeline");
  assert.equal(calls[0].auth, "Bearer tok");
  assert.deepEqual(calls[0].body, [
    ["SET", "k", "v"],
    ["EXPIRE", "k", "60"],
  ]);
});

test("upstash setNx lock: a null result means the lock is held", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify([{ result: null }]), { status: 200 })) as typeof fetch;
  const store = createRunStore(createUpstashBackend("https://db", "tok", fakeFetch));
  assert.equal(await store.acquireRunLock("r1", 60), null);
});

test("upstash backend throws on a per-command error or an HTTP failure", async () => {
  const errorReply = (async () =>
    new Response(JSON.stringify([{ error: "WRONGTYPE" }]), { status: 200 })) as typeof fetch;
  await assert.rejects(createUpstashBackend("https://db", "tok", errorReply).pipeline([["GET", "k"]]), /WRONGTYPE/);

  const httpFail = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(createUpstashBackend("https://db", "tok", httpFail).pipeline([["GET", "k"]]), /401/);
});

test("upstash drainDecisions maps a null LPOP reply to an empty list", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify([{ result: null }]), { status: 200 })) as typeof fetch;
  const store = createRunStore(createUpstashBackend("https://db", "tok", fakeFetch));
  assert.deepEqual(await store.drainDecisions("r1"), []);
});

test("progress and heartbeat keys carry their TTLs", async () => {
  const sent: string[][][] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as string[][];
    sent.push(body);
    return new Response(JSON.stringify(body.map(() => ({ result: 1 }))), { status: 200 });
  }) as typeof fetch;
  const store = createRunStore(createUpstashBackend("https://db", "tok", fakeFetch));

  await store.appendProgress("r1", [{ at: 1, message: "m" }]);
  assert.deepEqual(sent[0][1], ["EXPIRE", "run:r1:events", String(PROGRESS_TTL_SEC)]);

  await store.heartbeat(makeHeartbeat());
  assert.equal(sent[1][0][0], "SET");
  assert.deepEqual(sent[1][0].slice(0, 2), ["SET", "runner:heartbeat"]);
  assert.deepEqual(sent[1][0].slice(-2), ["EX", String(HEARTBEAT_TTL_SEC)]);
});

test("backendFromEnv uses memory outside production when unconfigured", async () => {
  const kv = backendFromEnv({ NODE_ENV: "development" });
  await kv.pipeline([["SET", "k", "v"]]);
  assert.deepEqual(await kv.pipeline([["GET", "k"]]), ["v"]);
});

test("backendFromEnv refuses to fall back to memory in production", () => {
  assert.throws(() => backendFromEnv({ NODE_ENV: "production" }), /required in production/);
});

test("backendFromEnv uses Upstash when both env vars are set", async () => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify([{ result: null }]), { status: 200 });
  }) as typeof fetch;
  try {
    const kv = backendFromEnv({
      NODE_ENV: "production",
      UPSTASH_REDIS_REST_URL: "https://db.example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    assert.deepEqual(await kv.pipeline([["GET", "k"]]), [null]);
    assert.deepEqual(seen, ["https://db.example.upstash.io/pipeline"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
