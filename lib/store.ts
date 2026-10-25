// Run persistence: Upstash Redis over REST, with an in-memory fallback for local dev.
//
// Keys:
//   run:<runId>            JSON Run record (ownerId is inside it)
//   user:<ownerId>:runs    sorted set, score = createdAt, member = runId (history index)
//   active:runs            sorted set, score = updatedAt, member = runId (non-terminal runs)
//   lock:run:<runId>       per-run lock, SET NX EX, value = holder token
//   decisions:<runId>      list of ApprovalDecision JSON, drained only by the step engine
//
// Reads from request handlers are owner-only: routes call getRun(ownerId, runId) and
// that is the only ownership check. The UI never writes run state; it only enqueues
// approval decisions, which the engine drains on its own schedule.

import { randomUUID } from "node:crypto";
import type { ApprovalDecision, Run, RunIndexEntry, RunStatus } from "./types";

export interface RunStore {
  saveRun(run: Run): Promise<void>;
  /** Owner-only read: null when the run is missing or belongs to someone else. */
  getRun(ownerId: string, runId: string): Promise<Run | null>;
  /** Engine-only read with no owner check. Never call from a request handler. */
  getRunForEngine(runId: string): Promise<Run | null>;
  /** Owner's run history, newest first. */
  listRunsForOwner(ownerId: string, limit?: number): Promise<RunIndexEntry[]>;
  /** Ids of runs that are not done or failed. Used by the cron kick. */
  listActiveRunIds(limit?: number): Promise<string[]>;
  /** SET NX EX. Returns a holder token when the lock is acquired, otherwise null. */
  acquireRunLock(runId: string, ttlSec?: number): Promise<string | null>;
  /** Releases only when `token` is still the holder. */
  releaseRunLock(runId: string, token: string): Promise<boolean>;
  /**
   * Queues an approval decision for the engine. Does not check ownership:
   * the route must call getRun(ownerId, runId) first.
   */
  enqueueDecision(runId: string, decision: ApprovalDecision): Promise<void>;
  /** Engine-only. Removes and returns up to `max` queued decisions, oldest first. */
  drainDecisions(runId: string, max?: number): Promise<ApprovalDecision[]>;
}

// Primitive operations both backends implement.
export interface KvBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setNxEx(key: string, value: string, ttlSec: number): Promise<boolean>;
  delIfEquals(key: string, value: string): Promise<boolean>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  /** Members from highest score down, at most `count`. */
  zrevrange(key: string, count: number): Promise<string[]>;
  rpush(key: string, value: string): Promise<void>;
  lpopMany(key: string, count: number): Promise<string[]>;
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "failed"]);
const ACTIVE_RUNS_KEY = "active:runs";

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) throw new Error("invalid run id");
}

const runKey = (runId: string) => `run:${runId}`;
const userRunsKey = (ownerId: string) => `user:${ownerId}:runs`;
const lockKey = (runId: string) => `lock:run:${runId}`;
const decisionsKey = (runId: string) => `decisions:${runId}`;

// Compare-and-delete so a holder can only release its own lock.
const RELEASE_LOCK_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

const DEFAULT_LOCK_TTL_SEC = 60;

export function createRunStore(kv: KvBackend): RunStore {
  async function readRun(runId: string): Promise<Run | null> {
    const raw = await kv.get(runKey(runId));
    return raw === null ? null : (JSON.parse(raw) as Run);
  }

  return {
    async saveRun(run) {
      assertRunId(run.id);
      await kv.set(runKey(run.id), JSON.stringify(run));
      await kv.zadd(userRunsKey(run.ownerId), run.createdAt, run.id);
      if (TERMINAL.has(run.status)) {
        await kv.zrem(ACTIVE_RUNS_KEY, run.id);
      } else {
        await kv.zadd(ACTIVE_RUNS_KEY, run.updatedAt, run.id);
      }
    },

    async getRun(ownerId, runId) {
      assertRunId(runId);
      const run = await readRun(runId);
      if (!run || run.ownerId !== ownerId) return null;
      return run;
    },

    async getRunForEngine(runId) {
      assertRunId(runId);
      return readRun(runId);
    },

    async listRunsForOwner(ownerId, limit = 50) {
      const ids = await kv.zrevrange(userRunsKey(ownerId), Math.max(1, limit));
      const entries: RunIndexEntry[] = [];
      for (const id of ids) {
        if (!RUN_ID_RE.test(id)) continue;
        const run = await readRun(id);
        // Index and record can disagree; only return runs this owner actually owns.
        if (!run || run.ownerId !== ownerId) continue;
        entries.push({
          id: run.id,
          ownerId: run.ownerId,
          task: run.task,
          repo: run.repo,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        });
      }
      return entries;
    },

    async listActiveRunIds(limit = 500) {
      const ids = await kv.zrevrange(ACTIVE_RUNS_KEY, Math.max(1, limit));
      return ids.filter((id) => RUN_ID_RE.test(id));
    },

    async acquireRunLock(runId, ttlSec = DEFAULT_LOCK_TTL_SEC) {
      assertRunId(runId);
      const token = randomUUID();
      return (await kv.setNxEx(lockKey(runId), token, ttlSec)) ? token : null;
    },

    async releaseRunLock(runId, token) {
      assertRunId(runId);
      return kv.delIfEquals(lockKey(runId), token);
    },

    async enqueueDecision(runId, decision) {
      assertRunId(runId);
      if (decision.runId !== runId) throw new Error("decision runId mismatch");
      await kv.rpush(decisionsKey(runId), JSON.stringify(decision));
    },

    async drainDecisions(runId, max = 100) {
      assertRunId(runId);
      const raw = await kv.lpopMany(decisionsKey(runId), Math.max(1, max));
      return raw.map((item) => JSON.parse(item) as ApprovalDecision);
    },
  };
}

// Upstash REST: POST a command as a JSON array to the database URL.
// Response is { result } on success or { error } on failure.
export function createUpstashBackend(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): KvBackend {
  const base = url.replace(/\/+$/, "");

  async function cmd<R>(...args: (string | number)[]): Promise<R> {
    const res = await fetchImpl(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
    });
    const body = (await res.json().catch(() => null)) as { result?: R; error?: string } | null;
    if (!res.ok || !body || body.error !== undefined) {
      throw new Error(`upstash ${args[0]} failed: ${body?.error ?? res.status}`);
    }
    return body.result as R;
  }

  return {
    get: (key) => cmd<string | null>("GET", key),
    async set(key, value) {
      await cmd("SET", key, value);
    },
    async setNxEx(key, value, ttlSec) {
      const r = await cmd<string | null>("SET", key, value, "NX", "EX", ttlSec);
      return r === "OK";
    },
    async delIfEquals(key, value) {
      const r = await cmd<number>("EVAL", RELEASE_LOCK_SCRIPT, 1, key, value);
      return r === 1;
    },
    async zadd(key, score, member) {
      await cmd("ZADD", key, score, member);
    },
    async zrem(key, member) {
      await cmd("ZREM", key, member);
    },
    zrevrange: (key, count) => cmd<string[]>("ZREVRANGE", key, 0, count - 1),
    async rpush(key, value) {
      await cmd("RPUSH", key, value);
    },
    async lpopMany(key, count) {
      const r = await cmd<string[] | null>("LPOP", key, count);
      return r ?? [];
    },
  };
}

// In-memory backend for local dev and tests. Not shared across processes or serverless invocations.
export function createMemoryBackend(now: () => number = Date.now): KvBackend {
  const kv = new Map<string, string>();
  const locks = new Map<string, { value: string; expiresAt: number }>();
  const zsets = new Map<string, Map<string, number>>();
  const lists = new Map<string, string[]>();

  function liveLock(key: string) {
    const lock = locks.get(key);
    if (!lock) return undefined;
    if (lock.expiresAt <= now()) {
      locks.delete(key);
      return undefined;
    }
    return lock;
  }

  return {
    async get(key) {
      return kv.get(key) ?? null;
    },
    async set(key, value) {
      kv.set(key, value);
    },
    async setNxEx(key, value, ttlSec) {
      if (liveLock(key)) return false;
      locks.set(key, { value, expiresAt: now() + ttlSec * 1000 });
      return true;
    },
    async delIfEquals(key, value) {
      const lock = liveLock(key);
      if (!lock || lock.value !== value) return false;
      locks.delete(key);
      return true;
    },
    async zadd(key, score, member) {
      let set = zsets.get(key);
      if (!set) {
        set = new Map();
        zsets.set(key, set);
      }
      set.set(member, score);
    },
    async zrem(key, member) {
      zsets.get(key)?.delete(member);
    },
    async zrevrange(key, count) {
      const set = zsets.get(key);
      if (!set) return [];
      return [...set.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([member]) => member);
    },
    async rpush(key, value) {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
    },
    async lpopMany(key, count) {
      const list = lists.get(key);
      if (!list) return [];
      return list.splice(0, count);
    },
  };
}

// Upstash when configured. Memory only outside production, so a misconfigured
// deploy fails loudly instead of quietly losing runs.
export function backendFromEnv(env: Record<string, string | undefined> = process.env): KvBackend {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createUpstashBackend(url, token);
  if (env.NODE_ENV === "production") {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in production");
  }
  return createMemoryBackend();
}

// Process-wide singleton, kept on globalThis so dev hot reloads reuse the same memory state.
const GLOBAL_KEY = "__maxworkflwRunStore";

export function getRunStore(): RunStore {
  const g = globalThis as unknown as Record<string, RunStore | undefined>;
  let store = g[GLOBAL_KEY];
  if (!store) {
    store = createRunStore(backendFromEnv());
    g[GLOBAL_KEY] = store;
  }
  return store;
}
