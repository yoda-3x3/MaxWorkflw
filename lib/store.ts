// Run persistence and the site <-> PC runner queue. Upstash Redis over REST, with an
// in-memory backend for local dev and tests. Runs on Cloudflare Workers: no fs, no child_process.
//
// Keys (the runner and the site both depend on these shapes):
//   run:<runId>            JSON Run record. Written by saveRun (site on create, runner on every step).
//   user:<ownerId>:runs    zset, score = createdAt, member = runId (history index).
//   active:runs            zset, score = updatedAt, member = runId (non-terminal runs).
//   decisions:<runId>      list of ApprovalDecision JSON. Pushed by the site, drained by the engine.
//   lock:run:<runId>       engine step lock, SET NX EX, value = holder token. Held for one step.
//   runner:queue           list of runIds, FIFO. Site RPUSHes on create and on each decision.
//                          Runner LPOPs. Duplicates are harmless: step() returns idle/locked/waiting.
//   runner:claim:<runId>   SET NX EX, value = runnerId. Queue-level ownership while the runner
//                          works a run. Released with a compare-and-delete on the runner id.
//   run:<runId>:events     list of RunEvent JSON, RPUSHed by the runner in batches and read by the
//                          site with LRANGE. Expires PROGRESS_TTL_SEC after the last append.
//   runner:heartbeat       SET EX HEARTBEAT_TTL_SEC, JSON RunnerHeartbeat. Missing = runner offline.
//
// Reads from request handlers are owner-only: routes call getRun(ownerId, runId), which is the
// only ownership check. The site never writes run state; it enqueues decisions and run ids.
//
// Every operation is one Upstash call (POST /pipeline), so a request costs one round trip per
// independent step. Pipelined commands are not transactional.

import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  Run,
  RunEvent,
  RunIndexEntry,
  RunnerHeartbeat,
  RunnerStatus,
  RunStatus,
} from "./types";

export const HEARTBEAT_TTL_SEC = 45;
export const PROGRESS_TTL_SEC = 30 * 24 * 60 * 60;
export const QUEUE_KEY = "runner:queue";
export const HEARTBEAT_KEY = "runner:heartbeat";

export interface RunStore {
  /** Saves the run. `queue: true` also RPUSHes its id onto runner:queue, in the same call. */
  saveRun(run: Run, opts?: { queue?: boolean }): Promise<void>;
  /** Owner-only read: null when the run is missing or belongs to someone else. */
  getRun(ownerId: string, runId: string): Promise<Run | null>;
  /** Engine-only read with no owner check. Never call from a request handler. */
  getRunForEngine(runId: string): Promise<Run | null>;
  /** Owner's run history, newest first. */
  listRunsForOwner(ownerId: string, limit?: number): Promise<RunIndexEntry[]>;
  /** Ids of runs that are not done or failed. Candidates for the runner's backstop re-queue. */
  listActiveRunIds(limit?: number): Promise<string[]>;
  /** SET NX EX on the engine step lock. Returns a holder token, or null when held. */
  acquireRunLock(runId: string, ttlSec?: number): Promise<string | null>;
  /** Releases only when `token` is still the holder. */
  releaseRunLock(runId: string, token: string): Promise<boolean>;
  /**
   * Queues an approval decision for the engine. Does not check ownership: the route must call
   * getRun(ownerId, runId) first. Does not wake the runner; use queueDecision for that.
   */
  enqueueDecision(runId: string, decision: ApprovalDecision): Promise<void>;
  /** Site: enqueues the decision and RPUSHes the run onto runner:queue, in one call. */
  queueDecision(runId: string, decision: ApprovalDecision): Promise<void>;
  /** Engine-only. Removes and returns up to `max` queued decisions, oldest first. */
  drainDecisions(runId: string, max?: number): Promise<ApprovalDecision[]>;
  /** Site: RPUSH a run id onto runner:queue. */
  enqueueRun(runId: string): Promise<void>;
  /** Runner: LPOP up to `max` run ids from runner:queue, oldest first. */
  popRuns(max?: number): Promise<string[]>;
  /** Runner: SET NX EX runner:claim:<runId>. True when this runner now holds the run. */
  claimRun(runId: string, runnerId: string, ttlSec?: number): Promise<boolean>;
  /** Runner: releases the claim only when `runnerId` still holds it. */
  releaseClaim(runId: string, runnerId: string): Promise<boolean>;
  /** Runner: RPUSHes progress events for a run, in one call. */
  appendProgress(runId: string, events: RunEvent[]): Promise<void>;
  /** Site: events from index `from` (default 0), at most `max`. `next` is the index to ask for next. */
  readProgress(runId: string, from?: number, max?: number): Promise<{ events: RunEvent[]; next: number }>;
  /** Runner: refreshes runner:heartbeat with TTL HEARTBEAT_TTL_SEC. */
  heartbeat(hb: RunnerHeartbeat): Promise<void>;
  /** Site: online when the heartbeat key is still alive. */
  getRunnerStatus(): Promise<RunnerStatus>;
}

// One Redis command as an array: ["SET", key, value, "NX"]. Numbers are stringified.
export type KvCommand = (string | number)[];

// The only primitive both backends implement. Results come back in command order. A failed
// command throws. Commands in one call are not transactional.
export interface KvBackend {
  pipeline(commands: KvCommand[]): Promise<unknown[]>;
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "failed"]);
const ACTIVE_RUNS_KEY = "active:runs";
const DEFAULT_LOCK_TTL_SEC = 60;
const DEFAULT_CLAIM_TTL_SEC = 3600;

// Compare-and-delete so a holder can only release its own key.
const RELEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) throw new Error("invalid run id");
}

const runKey = (runId: string) => `run:${runId}`;
const userRunsKey = (ownerId: string) => `user:${ownerId}:runs`;
const lockKey = (runId: string) => `lock:run:${runId}`;
const decisionsKey = (runId: string) => `decisions:${runId}`;
const claimKey = (runId: string) => `runner:claim:${runId}`;
const eventsKey = (runId: string) => `run:${runId}:events`;

export function createRunStore(kv: KvBackend): RunStore {
  const one = async <T>(cmd: KvCommand): Promise<T> => (await kv.pipeline([cmd]))[0] as T;

  // Compare-and-delete through EVAL. Returns true when the key held `value` and was deleted.
  async function delIfEquals(key: string, value: string): Promise<boolean> {
    return (await one<number>(["EVAL", RELEASE_SCRIPT, 1, key, value])) === 1;
  }

  // Ids popped from a list must still look like run ids before they are used as keys.
  const validIds = (ids: string[] | null | undefined) => (ids ?? []).filter((id) => RUN_ID_RE.test(id));

  async function readRun(runId: string): Promise<Run | null> {
    const raw = await one<string | null>(["GET", runKey(runId)]);
    return raw === null ? null : (JSON.parse(raw) as Run);
  }

  return {
    async saveRun(run, opts) {
      assertRunId(run.id);
      const cmds: KvCommand[] = [
        ["SET", runKey(run.id), JSON.stringify(run)],
        ["ZADD", userRunsKey(run.ownerId), run.createdAt, run.id],
        TERMINAL.has(run.status)
          ? ["ZREM", ACTIVE_RUNS_KEY, run.id]
          : ["ZADD", ACTIVE_RUNS_KEY, run.updatedAt, run.id],
      ];
      if (opts?.queue) cmds.push(["RPUSH", QUEUE_KEY, run.id]);
      await kv.pipeline(cmds);
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
      const ids = validIds(await one<string[]>(["ZREVRANGE", userRunsKey(ownerId), 0, Math.max(1, limit) - 1]));
      if (ids.length === 0) return [];
      const raws = await one<(string | null)[]>(["MGET", ...ids.map(runKey)]);
      const entries: RunIndexEntry[] = [];
      for (const raw of raws) {
        if (raw === null) continue;
        const run = JSON.parse(raw) as Run;
        // Index and record can disagree; only return runs this owner actually owns.
        if (run.ownerId !== ownerId) continue;
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
      return validIds(await one<string[]>(["ZREVRANGE", ACTIVE_RUNS_KEY, 0, Math.max(1, limit) - 1]));
    },

    async acquireRunLock(runId, ttlSec = DEFAULT_LOCK_TTL_SEC) {
      assertRunId(runId);
      const token = randomUUID();
      const ok = await one<string | null>(["SET", lockKey(runId), token, "NX", "EX", ttlSec]);
      return ok === "OK" ? token : null;
    },

    async releaseRunLock(runId, token) {
      assertRunId(runId);
      return delIfEquals(lockKey(runId), token);
    },

    async enqueueDecision(runId, decision) {
      assertRunId(runId);
      if (decision.runId !== runId) throw new Error("decision runId mismatch");
      await one(["RPUSH", decisionsKey(runId), JSON.stringify(decision)]);
    },

    async queueDecision(runId, decision) {
      assertRunId(runId);
      if (decision.runId !== runId) throw new Error("decision runId mismatch");
      await kv.pipeline([
        ["RPUSH", decisionsKey(runId), JSON.stringify(decision)],
        ["RPUSH", QUEUE_KEY, runId],
      ]);
    },

    async drainDecisions(runId, max = 100) {
      assertRunId(runId);
      const raw = await one<string[] | null>(["LPOP", decisionsKey(runId), Math.max(1, max)]);
      return (raw ?? []).map((item) => JSON.parse(item) as ApprovalDecision);
    },

    async enqueueRun(runId) {
      assertRunId(runId);
      await one(["RPUSH", QUEUE_KEY, runId]);
    },

    async popRuns(max = 5) {
      return validIds(await one<string[] | null>(["LPOP", QUEUE_KEY, Math.max(1, max)]));
    },

    async claimRun(runId, runnerId, ttlSec = DEFAULT_CLAIM_TTL_SEC) {
      assertRunId(runId);
      const ok = await one<string | null>(["SET", claimKey(runId), runnerId, "NX", "EX", ttlSec]);
      return ok === "OK";
    },

    async releaseClaim(runId, runnerId) {
      assertRunId(runId);
      return delIfEquals(claimKey(runId), runnerId);
    },

    async appendProgress(runId, events) {
      assertRunId(runId);
      if (events.length === 0) return;
      await kv.pipeline([
        ["RPUSH", eventsKey(runId), ...events.map((e) => JSON.stringify(e))],
        ["EXPIRE", eventsKey(runId), PROGRESS_TTL_SEC],
      ]);
    },

    async readProgress(runId, from = 0, max = 200) {
      assertRunId(runId);
      const start = Math.max(0, Math.floor(from));
      const raw = await one<string[] | null>(["LRANGE", eventsKey(runId), start, start + Math.max(1, max) - 1]);
      const events = (raw ?? []).map((item) => JSON.parse(item) as RunEvent);
      return { events, next: start + events.length };
    },

    async heartbeat(hb) {
      await one(["SET", HEARTBEAT_KEY, JSON.stringify(hb), "EX", HEARTBEAT_TTL_SEC]);
    },

    async getRunnerStatus() {
      const raw = await one<string | null>(["GET", HEARTBEAT_KEY]);
      if (raw === null) return { online: false };
      const hb = JSON.parse(raw) as RunnerHeartbeat;
      return { online: true, runnerId: hb.runnerId, host: hb.host, startedAt: hb.startedAt, lastSeen: hb.ts };
    },
  };
}

// Upstash REST pipeline: POST the command arrays to {url}/pipeline. The response is an array with
// one { result } or { error } per command, in order.
export function createUpstashBackend(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): KvBackend {
  const endpoint = `${url.replace(/\/+$/, "")}/pipeline`;
  return {
    async pipeline(commands) {
      if (commands.length === 0) return [];
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(commands.map((c) => c.map(String))),
      });
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string }[] | null;
      if (!res.ok || !Array.isArray(body) || body.length !== commands.length) {
        throw new Error(`upstash pipeline failed: ${res.status}`);
      }
      const bad = body.find((r) => r.error !== undefined);
      if (bad) throw new Error(`upstash command failed: ${bad.error}`);
      return body.map((r) => r.result);
    },
  };
}

// In-memory backend. It interprets the same command set the store sends, so tests exercise the
// real command layer. Not shared across processes or serverless invocations.
export function createMemoryBackend(now: () => number = Date.now): KvBackend {
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const lists = new Map<string, string[]>();
  const expires = new Map<string, number>();

  function purgeExpired() {
    const t = now();
    for (const [key, at] of expires) {
      if (at > t) continue;
      expires.delete(key);
      strings.delete(key);
      zsets.delete(key);
      lists.delete(key);
    }
  }

  function exec(cmd: KvCommand): unknown {
    const [name, ...rawArgs] = cmd.map(String);
    const args = rawArgs;
    switch (name.toUpperCase()) {
      case "GET":
        return strings.get(args[0]) ?? null;
      case "MGET":
        return args.map((k) => strings.get(k) ?? null);
      case "SET": {
        const [key, value, ...opts] = args;
        const nx = opts.includes("NX");
        const exIdx = opts.indexOf("EX");
        if (nx && strings.has(key)) return null;
        strings.set(key, value);
        if (exIdx >= 0) expires.set(key, now() + Number(opts[exIdx + 1]) * 1000);
        else expires.delete(key);
        return "OK";
      }
      case "EXPIRE": {
        const [key, sec] = args;
        if (!strings.has(key) && !lists.has(key) && !zsets.has(key)) return 0;
        expires.set(key, now() + Number(sec) * 1000);
        return 1;
      }
      case "EVAL": {
        const [script, , key, value] = args;
        if (script !== RELEASE_SCRIPT) throw new Error("memory backend: unsupported script");
        if (strings.get(key) !== value) return 0;
        strings.delete(key);
        expires.delete(key);
        return 1;
      }
      case "ZADD": {
        const [key, score, member] = args;
        let set = zsets.get(key);
        if (!set) {
          set = new Map();
          zsets.set(key, set);
        }
        set.set(member, Number(score));
        return 1;
      }
      case "ZREM":
        return zsets.get(args[0])?.delete(args[1]) ? 1 : 0;
      case "ZREVRANGE": {
        const [key, start, stop] = args;
        const set = zsets.get(key);
        if (!set) return [];
        const sorted = [...set.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)).map(([m]) => m);
        return sorted.slice(Number(start), Number(stop) + 1);
      }
      case "RPUSH": {
        const [key, ...values] = args;
        const list = lists.get(key) ?? [];
        list.push(...values);
        lists.set(key, list);
        return list.length;
      }
      case "LPOP": {
        const [key, count] = args;
        const list = lists.get(key);
        if (!list || list.length === 0) return null;
        if (count === undefined) return list.shift() ?? null;
        return list.splice(0, Number(count));
      }
      case "LRANGE": {
        const [key, start, stop] = args;
        const list = lists.get(key) ?? [];
        return list.slice(Number(start), Number(stop) + 1);
      }
      default:
        throw new Error(`memory backend: unsupported command ${name}`);
    }
  }

  return {
    async pipeline(commands) {
      purgeExpired();
      return commands.map(exec);
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
const GLOBAL_KEY = "__workflwproRunStore";

export function getRunStore(): RunStore {
  const g = globalThis as unknown as Record<string, RunStore | undefined>;
  let store = g[GLOBAL_KEY];
  if (!store) {
    store = createRunStore(backendFromEnv());
    g[GLOBAL_KEY] = store;
  }
  return store;
}
