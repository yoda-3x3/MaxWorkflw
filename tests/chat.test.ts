import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_CONTEXT_MESSAGES, chatUserPrompt, cleanChatText, pendingMessageIds, runContext } from "@/lib/chat";
import { CHAT_MAX_CHARS, type ChatMessage, type Run } from "@/lib/types";

const owner = (id: string, text = "q"): ChatMessage => ({ id, role: "user", text, createdAt: 1 });
const reply = (id: string, replyTo: string, text = "a"): ChatMessage => ({
  id,
  role: "assistant",
  text,
  replyTo,
  createdAt: 2,
});

test("cleanChatText trims, rejects empty, non-string and over-long text", () => {
  assert.equal(cleanChatText("  hi there \n"), "hi there");
  assert.equal(cleanChatText("   "), null);
  assert.equal(cleanChatText(42), null);
  assert.equal(cleanChatText(undefined), null);
  assert.equal(cleanChatText("x".repeat(CHAT_MAX_CHARS)), "x".repeat(CHAT_MAX_CHARS));
  assert.equal(cleanChatText("x".repeat(CHAT_MAX_CHARS + 1)), null);
});

test("pendingMessageIds lists owner messages with no reply, oldest first", () => {
  const messages = [owner("m1"), reply("r1", "m1"), owner("m2"), owner("m3"), reply("r3", "m3", "err")];
  assert.deepEqual(pendingMessageIds(messages), ["m2"]);
  assert.deepEqual(pendingMessageIds([owner("a"), owner("b")]), ["a", "b"]);
  assert.deepEqual(pendingMessageIds([]), []);
});

test("pendingMessageIds ignores orchestrator messages that answer nothing", () => {
  assert.deepEqual(pendingMessageIds([owner("m1"), reply("r0", "other")]), ["m1"]);
});

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    ownerId: "github:alice",
    task: "Build the thing",
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

test("runContext gives the task, plan summary, agent reports and pending approvals", () => {
  const text = runContext(
    makeRun({
      repo: "alice/app",
      plan: { summary: "Ship the login page", units: [] },
      agents: [
        { id: "a1", runId: "run-1", parentId: null, tier: 1, role: "orchestrator", title: "Orch", model: "m", status: "done", brief: "", deps: [], report: "planned it", attempts: 1, tokens: 0, createdAt: 1 },
        { id: "a2", runId: "run-1", parentId: "a1", tier: 2, role: "worker", title: "Login", model: "m", status: "failed", brief: "", deps: [], error: "tests red", attempts: 2, tokens: 0, createdAt: 1 },
      ],
      approvals: [{ id: "p1", runId: "run-1", agentId: "a2", kind: "production_deploy", request: "Deploy to prod", status: "pending", createdAt: 1 }],
      finalReport: "All done.",
    }),
  );
  assert.match(text, /RUN run-1 \| status: running/);
  assert.match(text, /REPO: alice\/app/);
  assert.match(text, /PLAN SUMMARY:\nShip the login page/);
  assert.match(text, /- a1 \(Orch, orchestrator\) \[done\]: planned it/);
  assert.match(text, /- a2 \(Login, worker\) \[failed\]: error: tests red/);
  assert.match(text, /WAITING FOR APPROVAL:\n- production_deploy: Deploy to prod/);
  assert.match(text, /FINAL REPORT:\nAll done\./);
});

test("runContext clips very long reports and skips empty sections", () => {
  const long = "word ".repeat(2000);
  const text = runContext(
    makeRun({
      agents: [{ id: "a1", runId: "run-1", parentId: null, tier: 1, role: "orchestrator", title: "O", model: "m", status: "done", brief: "", deps: [], report: long, attempts: 1, tokens: 0, createdAt: 1 }],
    }),
  );
  assert.ok(text.includes("[... clipped]"));
  assert.ok(text.length < 2000);
  assert.ok(!text.includes("PLAN SUMMARY"));
  assert.ok(!text.includes("WAITING FOR APPROVAL"));
});

test("chatUserPrompt puts context, the recent conversation, then the new message", () => {
  const transcript = [owner("m1", "first"), reply("r1", "m1", "answer one")];
  const prompt = chatUserPrompt({ message: "and now?", transcript, context: "RUN ctx" });
  assert.ok(prompt.startsWith("RUN CONTEXT:\nRUN ctx"));
  assert.match(prompt, /Owner: first\nOrchestrator: answer one/);
  assert.ok(prompt.endsWith("OWNER'S NEW MESSAGE:\nand now?"));
});

test("chatUserPrompt keeps only the last CHAT_CONTEXT_MESSAGES messages", () => {
  const transcript = Array.from({ length: CHAT_CONTEXT_MESSAGES + 5 }, (_, i) => owner(`m${i}`, `msg-${i}`));
  const prompt = chatUserPrompt({ message: "x", transcript });
  assert.ok(!prompt.includes("msg-0\n"));
  assert.ok(prompt.includes(`msg-${CHAT_CONTEXT_MESSAGES + 4}`));
  assert.ok(!prompt.includes("RUN CONTEXT"));
});
