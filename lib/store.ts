// Run persistence: Upstash Redis over REST, with an in-memory fallback for local dev.
//
// Keys:
//   run:<runId>            JSON run record (includes ownerId)
//   user:<ownerId>:runs    sorted set, score = createdAt, member = runId (index for listing)
//   lock:run:<runId>       per-run lock, SET NX EX, value = holder token
//   decisions:<runId>      list of approval decisions, drained only by the step engine
//
// Reads through the public API are owner-only. The UI never writes run state;
// it only enqueues decisions, which the engine drains.

// Structural minimum the store needs from a run. core's Run type must carry these.
export interface StoredRun {
  id: string;
  ownerId: string;
  createdAt: number;
}

export interface RunStore {
  saveRun(run: StoredRun): Promise<void>;
  // Owner-only read: returns null when the run does not exist or belongs to someone else.
  getRun<T extends StoredRun>(ownerId: string, runId: string): Promise<T | null>;
  // Engine-only read, no owner check. Never expose this to a request handler.
  getRunForEngine<T extends StoredRun>(runId: string): Promise<T | null>;
  listRuns<T extends StoredRun>(ownerId: string, limit?: number): Promise<T[]>;
  acquireRunLock(runId: string, token: string, ttlSec?: number): Promise<boolean>;
  releaseRunLock(runId: string, token: string): Promise<boolean>;
  // Owner-checked. Returns false when the run is not visible to ownerId.
  enqueueDecision<T>(ownerId: string, runId: string, decision: T): Promise<boolean>;
  // Engine-only. Removes and returns up to `max` queued decisions, oldest first.
  drainDecisions<T>(runId: string, max?: number): Promise<T[]>;
}

// Primitive operations both backends implement.
interface KvBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setNxEx(key: string, value: string, ttlSec: number): Promise<boolean>;
  delIfEquals(key: string, value: string): Promise<boolean>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrevrange(key: string, stop: number): Promise<string[]>;
  rpush(key: string, value: string): Promise<void>;
  lpopMany(key: string, count: number): Promise<string[]>;
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

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

export function createRunStore(kv: KvBackend): RunStore {
  return {
    async saveRun(run) {
      assertRunId(run.id);
      await kv.set(runKey(run.id), JSON.stringify(run));
      await kv.zadd(userRunsKey(run.ownerId), run.createdAt, run.id);
    },

    async getRun<T extends StoredRun>(ownerId: string, runId: string) {
      assertRunId(runId);
      const run = await readRun<T>(kv, runId);
      if (!run || run.ownerId !== ownerId) return null;
      return run;
    },

    async getRunForEngine<T extends StoredRun>(runId: string) {
      assertRunId(runId);
      return readRun<T>(kv, runId);
    },

    async listRuns<T extends StoredRun>(ownerId: string, limit = 50) {
      const ids = await kv.zrevrange(userRunsKey(ownerId), Math.max(0, limit - 1));
      const runs: T[] = [];
      for (const id of ids) {
        if (!RUN_ID_RE.test(id)) continue;
        const run = await readRun<T>(kv, id);
        // Index and record can disagree; only return runs this owner actually owns.
        if (run && run.ownerId === ownerId) runs.push(run);
      }
      return runs;
    },

    async acquireRunLock(runId, token, ttlSec = 60) {
      assertRunId(runId);
      return kv.setNxEx(lockKey(runId), token, ttlSec);
    },

    async releaseRunLock(runId, token) {
      assertRunId(runId);
      return kv.delIfEquals(lockKey(runId), token);
    },

    async enqueueDecision<T>(ownerId: string, runId: string, decision: T) {
      assertRunId(runId);
      const run = await readRun<StoredRun>(kv, runId);
      if (!run || run.ownerId !== ownerId) return false;
      await kv.rpush(decisionsKey(runId), JSON.stringify(decision));
      return true;
    },

    async drainDecisions<T>(runId: string, max = 100) {
      assertRunId(runId);
      const raw = await kv.lpopMany(decisionsKey(runId), Math.max(1, max));
      return raw.map((item) => JSON.parse(item) as T);
    },
  };
}

async function readRun<T extends StoredRun>(kv: KvBackend, runId: string): Promise<T | null> {
  const raw = await kv.get(runKey(runId));
  return raw === null ? null : (JSON.parse(raw) as T);
}

// Upstash REST: POST a command as a JSON array to the database URL.
// Response is { result } or { error }.
export function createUpstashBackend(url: string, token: string, fetchImpl: typeof fetch = fetch): KvBackend {
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
    zrevrange: (key, stop) => cmd<string[]>("ZREVRANGE", key, 0, stop),
    async rpush(key, value) {
      await cmd("RPUSH", key, value);
    },
    async lpopMany(key, count) {
      const r = await cmd<string[] | null>("LPOP", key, count);
      return r ?? [];
    },
  };
}

interface MemoryState {
  kv: Map<string, string>;
  locks: Map<string, { value: string; expiresAt: number }>;
  zsets: Map<string, Map<string, number>>;
  lists: Map<string, string[]>;
}

// In-memory backend for local dev and tests. Not durable across processes or serverless invocations.
export function createMemoryBackend(now: () => number = Date.now): KvBackend {
  const state: MemoryState = { kv: new Map(), locks: new Map(), zsets: new Map(), lists: new Map() };

  function liveLock(key: string) {
    const lock = state.locks.get(key);
    if (!lock) return undefined;
    if (lock.expiresAt <= now()) {
      state.locks.delete(key);
      return undefined;
    }
    return lock;
  }

  return {
    async get(key) {
      return state.kv.get(key) ?? null;
    },
    async set(key, value) {
      state.kv.set(key, value);
    },
    async setNxEx(key, value, ttlSec) {
      if (liveLock(key)) return false;
      state.locks.set(key, { value, expiresAt: now() + ttlSec * 1000 });
      return true;
    },
    async delIfEquals(key, value) {
      const lock = liveLock(key);
      if (!lock || lock.value !== value) return false;
      state.locks.delete(key);
      return true;
    },
    async zadd(key, score, member) {
      let set = state.zsets.get(key);
      if (!set) {
        set = new Map();
        state.zsets.set(key, set);
      }
      set.set(member, score);
    },
    async zrevrange(key, stop) {
      const set = state.zsets.get(key);
      if (!set) return [];
      return [...set.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, stop + 1)
        .map(([member]) => member);
    },
    async rpush(key, value) {
      const list = state.lists.get(key) ?? [];
      list.push(value);
      state.lists.set(key, list);
    },
    async lpopMany(key, count) {
      const list = state.lists.get(key);
      if (!list) return [];
      return list.splice(0, count);
    },
  };
}

// Picks Upstash when configured. Falls back to memory only outside production,
// so a misconfigured deploy fails loudly instead of silently losing runs.
export function backendFromEnv(env: Record<string, string | undefined> = process.env): KvBackend {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createUpstashBackend(url, token);
  if (env.NODE_ENV === "production") {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in production");
  }
  return createMemoryBackend();
}

// Process-wide singleton. Stored on globalThis so dev hot reloads keep the same memory state.
const GLOBAL_KEY = "__maxworkflwRunStore" as const;

export function getRunStore(): RunStore {
  const g = globalThis as unknown as Record<string, RunStore | undefined>;
  let store = g[GLOBAL_KEY];
  if (!store) {
    store = createRunStore(backendFromEnv());
    g[GLOBAL_KEY] = store;
  }
  return store;
}
