import { randomUUID } from "node:crypto";
import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; approvalId: string }> };

const MAX_NOTE_CHARS = 2000;

/**
 * Records the owner's decision and wakes the runner, in one Upstash call. The engine applies the
 * decision on the runner's next step, so this route never writes run state directly.
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

  await store.queueDecision(run.id, {
    id: randomUUID(),
    runId: run.id,
    approvalId,
    decision: body.decision === "approve" ? "approved" : "denied",
    note: note || undefined,
    decidedAt: Date.now(),
  });
  return json({ queued: true }, 202);
}
