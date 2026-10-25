// Draft: end-to-end run through engine.step() on the in-memory store, with the Llm port mocked.
// Written against the agreed contract (lib/llm.ts): Llm.complete / Llm.work, and work() returns
// { text, usage, approval? }. Replaces tests/e2e.test.ts once engine-llm lands on main.
// Covers: plan (complete) -> parallel wave with one failure and retry -> lead integration ->
// standalone worker that pauses for approval -> approval resume via the decision queue -> final.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockLlm, type MockCall, type MockReply } from "@/lib/llm";
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

function setup(handler: (call: MockCall) => MockReply | Promise<MockReply>) {
  const llm = createMockLlm(handler);
  const store = createRunStore(createMemoryBackend());
  const deps: EngineDeps = {
    llm,
    store,
    github: () => {
      throw new Error("github is not used in this run");
    },
    models: MODELS,
    now: () => Date.now(),
  };
  return { llm, store, deps };
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

// The prompt the agent receives. Routing keys off this text, not call order.
function promptOf(call: MockCall): string {
  return call.req.prompt;
}

test("full run: plan, parallel wave with retry, lead integration, approval pause/resume, final", async () => {
  const attempts = new Map<string, number>();
  let shipCalls = 0;

  const { llm, store, deps } = setup((call) => {
    const { req } = call;
    const prompt = promptOf(call);

    if (call.kind === "complete" && req.system === plannerSystemPrompt()) {
      return { text: JSON.stringify(PLAN) };
    }
    if (call.kind === "complete" && req.system === finalSystemPrompt()) {
      return { text: "FINAL: scans integrated and shipped" };
    }
    if (call.kind === "work" && req.system === leadSystemPrompt()) {
      // The lead must see its workers' reports to integrate them.
      const both = prompt.includes("scan A report") && prompt.includes("scan B report");
      return { text: "LEAD INTEGRATED: " + (both ? "both" : "missing") };
    }
    if (call.kind === "work" && req.system === workerSystemPrompt()) {
      if (prompt.includes("SCAN_B")) {
        const n = (attempts.get("B") ?? 0) + 1;
        attempts.set("B", n);
        // One failure, then a retry that succeeds.
        if (n === 1) throw new Error("upstream 503");
        return { text: "scan B report" };
      }
      if (prompt.includes("SCAN_A")) return { text: "scan A report" };
      if (prompt.includes("SHIP")) {
        shipCalls += 1;
        // First attempt asks for approval (hard stop 1: production deploy).
        if (shipCalls === 1) {
          return { text: "", approval: { rule: 1, request: "Deploy to production" } };
        }
        return { text: "release note written after approval" };
      }
    }
    throw new Error(`unexpected mock call: ${call.kind} ${req.system ?? "(no system)"}`);
  });

  const run = await createRun({ ownerId: "alice@example.com", task: "ship the thing" }, deps);

  // Plan, then waves, then the Ship worker pauses. Nothing else is runnable.
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
  const models = new Set(llm.calls.map((c) => c.req.model));
  assert.deepEqual([...models].sort(), [MODELS.lead, MODELS.orchestrator, MODELS.worker].sort());
});

test("a worker that keeps failing is marked failed and the run still finalizes", async () => {
  const { store, deps } = setup((call) => {
    const prompt = promptOf(call);
    if (call.kind === "complete" && call.req.system === plannerSystemPrompt()) {
      return { text: JSON.stringify(PLAN) };
    }
    if (call.kind === "complete" && call.req.system === finalSystemPrompt()) {
      return { text: "FINAL: partial" };
    }
    if (call.req.system === leadSystemPrompt()) return { text: "LEAD" };
    if (prompt.includes("SCAN_B")) throw new Error("always broken");
    if (prompt.includes("SCAN_A")) return { text: "scan A report" };
    return { text: "ship note" };
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
