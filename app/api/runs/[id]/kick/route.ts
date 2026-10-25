import { dispatchRun, getCaller, json, runAfterResponse } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const TERMINAL = new Set(["done", "failed"]);
/** A run updated more recently than this is still moving on its own, so a kick would be noise. */
const STALE_MS = 90_000;

/**
 * UI backup driver: opening a run re-kicks it. Owner-only (404 for anyone else). Dispatches only
 * when the run is active and has not been updated for STALE_MS, so a healthy run is not poked.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const run = await getRunStore().getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);

  const active = !TERMINAL.has(run.status);
  const stale = Date.now() - run.updatedAt > STALE_MS;
  if (!active || !stale) return json({ status: run.status, kicked: false });

  runAfterResponse(() => dispatchRun(run.id));
  return json({ status: run.status, kicked: true }, 202);
}
