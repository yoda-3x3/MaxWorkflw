import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_CLOUD_QUEUE_KEY, CHAT_QUEUE_KEY, createMemoryBackend, createRunStore } from "@/lib/store";
import { CHAT_HISTORY_MAX, type ChatJob, type ChatMessage } from "@/lib/types";

const msg = (id: string, role: ChatMessage["role"] = "user", runId?: string): ChatMessage => ({
  id,
  role,
  text: `text ${id}`,
  createdAt: 1,
  ...(runId ? { runId } : {}),
});

const job = (id: string, extra: Partial<ChatJob> = {}): ChatJob => ({
  id,
  ownerId: "github:alice",
  messageId: `m-${id}`,
  text: `q ${id}`,
  createdAt: 1,
  ...extra,
});

test("general and per-run chats are separate, per owner", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.appendChatMessages("github:alice", undefined, [msg("g1")]);
  await store.appendChatMessages("github:alice", "run-1", [msg("r1", "user", "run-1")]);
  await store.appendChatMessages("github:bob", undefined, [msg("b1")]);

  assert.deepEqual((await store.listChatMessages("github:alice", undefined)).map((m) => m.id), ["g1"]);
  assert.deepEqual((await store.listChatMessages("github:alice", "run-1")).map((m) => m.id), ["r1"]);
  assert.deepEqual((await store.listChatMessages("github:bob", undefined)).map((m) => m.id), ["b1"]);
  assert.deepEqual(await store.listChatMessages("github:alice", "run-2"), []);
});

test("messages come back oldest first, and an empty append is a no-op", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.appendChatMessages("github:alice", undefined, []);
  await store.appendChatMessages("github:alice", undefined, [msg("1")]);
  await store.appendChatMessages("github:alice", undefined, [msg("2", "assistant"), msg("3")]);
  const got = await store.listChatMessages("github:alice", undefined);
  assert.deepEqual(got.map((m) => m.id), ["1", "2", "3"]);
  assert.equal(got[1].role, "assistant");
});

test("history is trimmed to CHAT_HISTORY_MAX, keeping the newest", async () => {
  const store = createRunStore(createMemoryBackend());
  const many = Array.from({ length: CHAT_HISTORY_MAX + 7 }, (_, i) => msg(`m${i}`));
  await store.appendChatMessages("github:alice", undefined, many);
  const got = await store.listChatMessages("github:alice", undefined);
  assert.equal(got.length, CHAT_HISTORY_MAX);
  assert.equal(got[0].id, "m7");
  assert.equal(got[got.length - 1].id, `m${CHAT_HISTORY_MAX + 6}`);
});

test("listChatMessages limit returns only the newest messages", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.appendChatMessages("github:alice", undefined, [msg("a"), msg("b"), msg("c"), msg("d")]);
  assert.deepEqual((await store.listChatMessages("github:alice", undefined, 2)).map((m) => m.id), ["c", "d"]);
});

test("enqueueChatJob puts the job on the PC chat queue; popChatJobs returns it once", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.enqueueChatJob(job("j1"));
  await store.enqueueChatJob(job("j2"), "pc");
  const first = await store.popChatJobs(5, "pc");
  assert.deepEqual(first.map((j) => j.id), ["j1", "j2"]);
  assert.equal(first[0].messageId, "m-j1");
  assert.deepEqual(await store.popChatJobs(5, "pc"), []);
});

test("cloud chat jobs stay on the cloud queue, out of the PC's reach", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.enqueueChatJob(job("c1"), "cloud");
  assert.deepEqual(await store.popChatJobs(5, "pc"), []);
  assert.deepEqual((await store.popChatJobs(5, "cloud")).map((j) => j.id), ["c1"]);
});

test("chat queue keys are distinct from the run queues", () => {
  assert.notEqual(CHAT_QUEUE_KEY, CHAT_CLOUD_QUEUE_KEY);
  assert.ok(!CHAT_QUEUE_KEY.startsWith("runner:queue"));
});

test("popChatJobs skips ids whose job record is gone", async () => {
  const backend = createMemoryBackend();
  const store = createRunStore(backend);
  await backend.pipeline([["RPUSH", CHAT_QUEUE_KEY, "ghost"]]);
  await store.enqueueChatJob(job("real"));
  assert.deepEqual((await store.popChatJobs(5, "pc")).map((j) => j.id), ["real"]);
});

test("enqueueChatJob rejects a job id with unsafe characters", async () => {
  const store = createRunStore(createMemoryBackend());
  await assert.rejects(store.enqueueChatJob(job("bad id!")), /invalid chat job id/);
});
