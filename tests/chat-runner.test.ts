import { test } from "node:test";
import assert from "node:assert/strict";
import { answerChat, answerQueuedChats } from "@/scripts/lib/chat";
import { createMockLlm } from "@/lib/llm";
import { createMemoryBackend, createRunStore } from "@/lib/store";
import type { ChatJob, ChatMessage, Run } from "@/lib/types";
import { orchestratorChatSystemPrompt } from "@/lib/prompts";

const OWNER = "github:alice";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    ownerId: OWNER,
    task: "Ship the login page",
    status: "running",
    tokens: 0,
    agents: [],
    approvals: [],
    events: [],
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 2,
    ...overrides,
  };
}

// Stores the owner's question the way the route does, then returns the job the runner would pop.
async function ask(
  store: ReturnType<typeof createRunStore>,
  text: string,
  runId?: string,
  id = `job-${Math.random().toString(36).slice(2, 8)}`,
): Promise<ChatJob> {
  const message: ChatMessage = { id: `m-${id}`, role: "user", text, createdAt: 1, ...(runId ? { runId } : {}) };
  const job: ChatJob = { id, ownerId: OWNER, messageId: message.id, text, createdAt: 1, ...(runId ? { runId } : {}) };
  await store.appendChatMessages(OWNER, runId, [message]);
  await store.enqueueChatJob(job, "pc");
  return job;
}

let n = 0;
const newId = () => `reply-${++n}`;

test("answerChat appends the Orchestrator's reply, linked to the question", async () => {
  const store = createRunStore(createMemoryBackend());
  const llm = createMockLlm(() => ({ text: "  Start with the login form.  " }));
  const job = await ask(store, "What's next?");
  const [popped] = await store.popChatJobs(1, "pc");

  const reply = await answerChat(popped, { store, llm, model: "claude-opus-5-5", now: () => 99, newId });

  assert.equal(reply.role, "assistant");
  assert.equal(reply.text, "Start with the login form.");
  assert.equal(reply.replyTo, job.messageId);
  assert.equal(reply.model, "claude-opus-5-5");
  assert.equal(reply.error, undefined);
  const chat = await store.listChatMessages(OWNER, undefined);
  assert.deepEqual(chat.map((m) => m.role), ["user", "assistant"]);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].req.model, "claude-opus-5-5");
  assert.equal(llm.calls[0].req.system, orchestratorChatSystemPrompt());
});

test("answerChat includes the run's context for a run chat", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.saveRun(makeRun({ plan: { summary: "Login page in two units", units: [] } }));
  const llm = createMockLlm(() => ({ text: "ok" }));
  await ask(store, "How is it going?", "run-1");
  const [popped] = await store.popChatJobs(1, "pc");

  await answerChat(popped, { store, llm, model: "m", now: () => 1, newId });

  const prompt = llm.calls[0].req.prompt;
  assert.match(prompt, /RUN CONTEXT:/);
  assert.match(prompt, /PLAN SUMMARY:\nLogin page in two units/);
  assert.match(prompt, /OWNER'S NEW MESSAGE:\nHow is it going\?/);
  const chat = await store.listChatMessages(OWNER, "run-1");
  assert.equal(chat[chat.length - 1].runId, "run-1");
});

test("answerChat does not send another owner's run context", async () => {
  const store = createRunStore(createMemoryBackend());
  await store.saveRun(makeRun({ ownerId: "github:bob", task: "Bob's secret task" }));
  const llm = createMockLlm(() => ({ text: "ok" }));
  await ask(store, "hi", "run-1");
  const [popped] = await store.popChatJobs(1, "pc");

  await answerChat(popped, { store, llm, model: "m", now: () => 1, newId });

  assert.ok(!llm.calls[0].req.prompt.includes("Bob's secret task"));
  assert.match(llm.calls[0].req.prompt, /no longer available/);
});

test("a model failure becomes an error reply, so the question is not left pending", async () => {
  const store = createRunStore(createMemoryBackend());
  const llm = createMockLlm(() => {
    throw new Error("rate limited");
  });
  const job = await ask(store, "hello?");
  const [popped] = await store.popChatJobs(1, "pc");

  const reply = await answerChat(popped, { store, llm, model: "m", now: () => 1, newId });

  assert.equal(reply.error, "rate limited");
  assert.match(reply.text, /couldn't answer that: rate limited/);
  assert.equal(reply.replyTo, job.messageId);
  const chat = await store.listChatMessages(OWNER, undefined);
  assert.equal(chat[chat.length - 1].error, "rate limited");
});

test("an empty model reply is treated as a failure", async () => {
  const store = createRunStore(createMemoryBackend());
  const llm = createMockLlm(() => ({ text: "   " }));
  await ask(store, "hello?");
  const [popped] = await store.popChatJobs(1, "pc");
  const reply = await answerChat(popped, { store, llm, model: "m", now: () => 1, newId });
  assert.equal(reply.error, "the model returned an empty reply");
});

test("answerQueuedChats answers every queued job and reports the count", async () => {
  const store = createRunStore(createMemoryBackend());
  const llm = createMockLlm((call) => ({ text: `answer to ${call.req.prompt.split("\n").at(-1)}` }));
  await ask(store, "first", undefined, "j1");
  await ask(store, "second", undefined, "j2");
  const logs: string[] = [];

  const handled = await answerQueuedChats({ store, llm, model: "m", placement: "pc", log: (l) => logs.push(l), newId });

  assert.equal(handled, 2);
  assert.equal(logs.length, 2);
  const chat = await store.listChatMessages(OWNER, undefined);
  assert.deepEqual(chat.map((m) => m.role), ["user", "user", "assistant", "assistant"]);
  assert.equal(await answerQueuedChats({ store, llm, model: "m", placement: "pc", newId }), 0);
});
