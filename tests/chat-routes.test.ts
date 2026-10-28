import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { getRunStore } from "@/lib/store";
import type { Run } from "@/lib/types";
import { GET, POST } from "@/app/api/chat/route";

const SESSION_SECRET_VALUE = "test-session-secret-0123456789abcdef";

let saved: Record<string, string | undefined>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__workflwproRunStore;
  saved = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    ALLOWED_USERS: process.env.ALLOWED_USERS,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  process.env.SESSION_SECRET = SESSION_SECRET_VALUE;
  process.env.ALLOWED_USERS = "alice,bob";
  // No GITHUB_TOKEN: a cloud placement then reports cloudError without calling GitHub.
  delete process.env.GITHUB_TOKEN;
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

const aliceCookie = () => cookieFor("alice");

function post(body: unknown, cookie?: string): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function get(query = "", cookie?: string): Request {
  return new Request(`http://localhost/api/chat${query}`, { headers: cookie ? { cookie } : {} });
}

async function seedRun(ownerId: string, id: string): Promise<void> {
  const run: Run = {
    id,
    ownerId,
    task: "t",
    status: "running",
    tokens: 0,
    agents: [],
    approvals: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 2,
  };
  await getRunStore().saveRun(run);
}

async function setRunnerOnline(online: boolean): Promise<void> {
  if (!online) return;
  await getRunStore().heartbeat({ runnerId: "pc-1", pid: 1, host: "PC", startedAt: 1, ts: Date.now() });
}

describe("/api/chat", () => {
  test("rejects signed-out callers on both verbs", async () => {
    assert.equal((await GET(get())).status, 401);
    assert.equal((await POST(post({ text: "hi" }))).status, 401);
  });

  test("POST stores the question, queues it for the PC when it is online, and returns 201", async () => {
    await setRunnerOnline(true);
    const res = await POST(post({ text: "  What's the status?  " }, await aliceCookie()));
    assert.equal(res.status, 201);
    const body = (await res.json()) as { message: { id: string; role: string; text: string }; placement: string };
    assert.equal(body.placement, "pc");
    assert.equal(body.message.role, "user");
    assert.equal(body.message.text, "What's the status?");

    const history = (await (await GET(get("", await aliceCookie()))).json()) as {
      messages: { id: string }[];
      pending: string[];
      runner: { online: boolean };
    };
    assert.deepEqual(history.messages.map((m) => m.id), [body.message.id]);
    assert.deepEqual(history.pending, [body.message.id]);
    assert.equal(history.runner.online, true);
    assert.deepEqual((await getRunStore().popChatJobs(5, "pc")).map((j) => j.messageId), [body.message.id]);
  });

  test("POST with the PC offline goes to the cloud and reports why when the dispatch fails", async () => {
    const res = await POST(post({ text: "hello" }, await aliceCookie()));
    assert.equal(res.status, 201);
    const body = (await res.json()) as { placement: string; cloudError?: string };
    assert.equal(body.placement, "cloud");
    assert.match(body.cloudError ?? "", /GITHUB_TOKEN/);
    assert.equal((await getRunStore().popChatJobs(5, "cloud")).length, 1);
    assert.equal((await getRunStore().popChatJobs(5, "pc")).length, 0);
  });

  test("POST validates the text", async () => {
    const cookie = await aliceCookie();
    assert.equal((await POST(post({ text: "   " }, cookie))).status, 400);
    assert.equal((await POST(post({ text: 42 }, cookie))).status, 400);
    assert.equal((await POST(post({ text: "x".repeat(4001) }, cookie))).status, 400);
    assert.equal((await POST(post({ text: "ok" }, cookie))).status, 201);
  });

  test("a run chat is scoped to the owner's run", async () => {
    await seedRun("github:alice", "run-a");
    await seedRun("github:bob", "run-b");
    const cookie = await aliceCookie();

    const mine = await POST(post({ text: "about a", runId: "run-a" }, cookie));
    assert.equal(mine.status, 201);
    const runChat = (await (await GET(get("?runId=run-a", cookie))).json()) as { messages: { runId?: string }[] };
    assert.equal(runChat.messages.length, 1);
    assert.equal(runChat.messages[0].runId, "run-a");

    const general = (await (await GET(get("", cookie))).json()) as { messages: unknown[] };
    assert.equal(general.messages.length, 0);

    assert.equal((await POST(post({ text: "x", runId: "run-b" }, cookie))).status, 404);
    assert.equal((await GET(get("?runId=run-b", cookie))).status, 404);
    assert.equal((await POST(post({ text: "x", runId: "../etc" }, cookie))).status, 400);
    assert.equal((await GET(get("?runId=bad%20id", cookie))).status, 400);
  });

  test("one owner cannot read another owner's chat", async () => {
    const bob = await cookieFor("bob");
    await POST(post({ text: "bob's private note" }, bob));
    const alice = (await (await GET(get("", await aliceCookie()))).json()) as { messages: unknown[] };
    assert.equal(alice.messages.length, 0);
  });

  test("the runner notice is false when there is no heartbeat", async () => {
    const body = (await (await GET(get("", await aliceCookie()))).json()) as { runner: { online: boolean } };
    assert.equal(body.runner.online, false);
  });
});
