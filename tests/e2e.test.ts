// End-to-end run through the real engine and in-memory store, with Claude mocked.
// Covers: plan -> parallel wave (with one failure and retry) -> lead integration ->
// standalone worker that pauses for approval -> approval resume -> final report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockClaude, textReply, toolReply, type MockRequest } from "@/lib/claude";
import { createMemoryBackend, createRunStore } from "@/lib/store";
import { createRun, step, type EngineDeps } from "@/lib/engine";
import {
  finalSystemPrompt,
  leadSystemPrompt,
  plannerSystemPrompt,
  workerSystemPrompt,
} from "@/lib/prompts";
import type { ApprovalDecision, Plan } from "@/lib/types";

const MODELS = { orchestrator: "model-opus", lead: "model-sonnet", worker: "model-haiku" };

const PLAN: Plan = {
  summary: "Two scans, integrate them, then ship",
  units: [
    {
      id: "u1",
      title: "Research",
      brief: "RESEARCH_UNIT gather facts",
      deps: [],
      workers: [
        { id: "w1", title: "Scan A", brief: "SCAN_A look at module a", deps: [] },
        { id: "w2", title: "Scan B", brief: "SCAN_B look at module b", deps: [] },
      ],
    },
    { id: "u2", title: "Ship", brief: "SHIP write the release note", deps: ["u1"] },
  ],
};

function setup(handler: (req: MockRequest) => ReturnType<typeof textReply> | Promise<ReturnType<typeof textReply>>) {
  const claude = createMockClaude(handler);
  const store = createRunStore(createMemoryBackend());
  const deps: EngineDeps = {
    claude,
    store,
    github: () => {
      throw new Error("github is not used in this run");
    },
    models: MODELS,
    now: () => Date.now(),
  };
  return { claude, store, deps };
}

// Steps until the run stops needing an immediate next step (paused, finished, or failed).
async function driveUntilSettled(runId: string, deps: EngineDeps) {
  const actions: string[] = [];
  for (let i = 0; i < 40; i++) {
    const r = await step(runId, deps);
    actions.push(r.action);
    if (!r.more) return { last: r, actions };
  }
  throw new Error(`engine did not settle; actions so far: ${actions.join(",")}`);
}

function userText(req: MockRequest): string {
  const first = req.messages[0];
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
}

test("full run: plan, parallel wave with retry, lead integration, approval pause/resume, final", async () => {
  const attempts = new Map<string, number>();
  let shipCalls = 0;

  const { claude, store, deps } = setup((req) => {
    if (req.system === plannerSystemPrompt()) return textReply(JSON.stringify(PLAN));
    if (req.system === finalSystemPrompt()) return textReply("FINAL: scans integrated and shipped");

    const text = userText(req);
    if (req.system === leadSystemPrompt()) {
      // The lead must see its workers' reports to integrate them.
      return textReply("LEAD INTEGRATED: " + (text.includes("scan A report") && text.includes("scan B report") ? "both" : "missing"));
    }
    if (req.system === workerSystemPrompt()) {
      if (text.includes("SCAN_B")) {
        const n = (attempts.get("B") ?? 0) + 1;
        attempts.set("B", n);
        // One failure, then a retry that succeeds.
        if (n === 1) throw new Error("upstream 503");
        return textReply("scan B report");
      }
      if (text.includes("SCAN_A")) return textReply("scan A report");
      if (text.includes("SHIP")) {
        shipCalls += 1;
        // First attempt asks for approval (hard stop 1: production deploy).
        if (shipCalls === 1) {
          return toolReply([{ id: "tu1", name: "request_approval", input: { rule: 1, request: "Deploy to production" } }]);
        }
        return textReply("release note written after approval");
      }
    }
    throw new Error("unexpected mock request");
  });

  const run = await createRun({ ownerId: "alice@example.com", task: "ship the thing" }, deps);

  // Plan + wave + wave + wave + wave, then the Ship worker pauses. Nothing else is runnable.
  const paused = await driveUntilSettled(run.id, deps);
  assert.equal(paused.last.action, "waiting");
  assert.equal(paused.last.more, false);

  let saved = await store.getRunForEngine(run.id);
  assert(saved);
  assert.equal(saved.status, "waiting_approval");
  assert.equal(saved.plan?.units.length, 2);
  const shipAgent = saved.agents.find((a) => a.title === "Ship");
  assert(shipAgent);
  assert.equal(shipAgent.status, "waiting_approval");
  assert.equal(saved.approvals.length, 1);
  const approval = saved.approvals[0];
  assert.equal(approval.status, "pending");
  assert.equal(approval.kind, "production_deploy");

  // The lead integrated both worker reports, and Scan B retried once.
  const lead = saved.agents.find((a) => a.role === "lead");
  assert.equal(lead?.status, "done");
  assert.match(lead?.report ?? "", /LEAD INTEGRATED: both/);
  assert.equal(attempts.get("B"), 2);
  assert.equal(saved.agents.find((a) => a.title === "Scan B")?.status, "done");

  // Owner approves: the decision goes through the queue, then a step resumes only Ship.
  const decision: ApprovalDecision = {
    id: "d1",
    runId: run.id,
    approvalId: approval.id,
    decision: "approved",
    note: "go ahead",
    decidedAt: Date.now(),
  };
  await store.enqueueDecision(run.id, decision);

  const finished = await driveUntilSettled(run.id, deps);
  assert.equal(finished.last.action, "finalized");
  assert.equal(finished.last.more, false);

  saved = await store.getRunForEngine(run.id);
  assert(saved);
  assert.equal(saved.status, "done");
  assert.equal(saved.error, undefined);
  assert.equal(saved.approvals[0].status, "approved");
  assert.equal(saved.agents.find((a) => a.title === "Ship")?.status, "done");
  assert.equal(shipCalls, 2);
  assert.match(saved.finalReport ?? "", /FINAL: scans integrated and shipped/);
  assert(saved.tokens > 0);

  // Every model call used the expected tier's model.
  const models = new Set(claude.requests.map((r) => r.model));
  assert.deepEqual([...models].sort(), [MODELS.lead, MODELS.orchestrator, MODELS.worker].sort());
});

test("a worker that keeps failing is marked failed and the run still finalizes", async () => {
  const { store, deps } = setup((req) => {
    if (req.system === plannerSystemPrompt()) return textReply(JSON.stringify(PLAN));
    if (req.system === finalSystemPrompt()) return textReply("FINAL: partial");
    if (req.system === leadSystemPrompt()) return textReply("LEAD");
    const text = userText(req);
    if (text.includes("SCAN_B")) throw new Error("always broken");
    if (text.includes("SCAN_A")) return textReply("scan A report");
    return textReply("ship note");
  });

  const run = await createRun({ ownerId: "alice@example.com", task: "partial" }, deps);
  const done = await driveUntilSettled(run.id, deps);
  assert.equal(done.last.action, "finalized");

  const saved = await store.getRunForEngine(run.id);
  assert(saved);
  const scanB = saved.agents.find((a) => a.title === "Scan B");
  assert.equal(scanB?.status, "failed");
  assert.equal(scanB?.attempts, 2);
  assert.equal(saved.status, "done");
  assert.match(saved.finalReport ?? "", /FINAL: partial/);
});
