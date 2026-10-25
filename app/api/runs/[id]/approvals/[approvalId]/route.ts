import { randomUUID } from "node:crypto";
import { getCaller, json, scheduleKick } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; approvalId: string }> };

const MAX_NOTE_CHARS = 2000;

/**
 * Records the owner's decision in the decision queue. The step engine applies it, so this
 * route never writes run state directly and cannot race a running step.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id, approvalId } = await params;
  const store = getRunStore();
  const run = await store.getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);

  const body = (await req.json().catch(() => null)) as { decision?: unknown; note?: unknown } | null;
  if (body?.decision !== "approve" && body?.decision !== "deny") {
    return json({ error: "decision must be 'approve' or 'deny'" }, 400);
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE_CHARS) : undefined;

  const approval = run.approvals.find((a) => a.id === approvalId);
  if (!approval) return json({ error: "not found" }, 404);
  if (approval.status !== "pending") return json({ error: "approval already decided" }, 409);

  await store.enqueueDecision(run.id, {
    id: randomUUID(),
    runId: run.id,
    approvalId,
    decision: body.decision === "approve" ? "approved" : "denied",
    note: note || undefined,
    decidedAt: Date.now(),
  });
  scheduleKick(new URL(req.url).origin, run.id);
  return json({ queued: true }, 202);
}
