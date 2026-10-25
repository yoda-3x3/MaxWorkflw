import { dispatchRun, isCronAuthorized, json, runAfterResponse } from "@/lib/session";
import { getRunStore } from "@/lib/store";
import type { Run } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A run counts as stalled when nothing has written to it for this long. */
const STALE_AFTER_MS = 3 * 60 * 1000;
/** Caps the fan-out per invocation. The next cron tick picks up anything left over. */
const MAX_KICKS = 20;
/** How many active run ids to read per tick before filtering for stale ones. */
const SCAN_LIMIT = 500;

/**
 * Backup driver for stalled runs (Vercel cron, Bearer CRON_SECRET). Dispatches the oldest
 * active runs whose updatedAt is more than STALE_AFTER_MS ago. Runs waiting on approval are
 * skipped, since nothing can progress until a human decides.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return json({ error: "unauthorized" }, 401);

  const store = getRunStore();
  const ids = await store.listActiveRunIds(SCAN_LIMIT);
  const runs = await Promise.all(ids.map((id) => store.getRunForEngine(id)));

  const cutoff = Date.now() - STALE_AFTER_MS;
  const stale = runs
    .filter((run): run is Run => run !== null && isStalled(run, cutoff))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, MAX_KICKS);

  // Each dispatch is independent. dispatchRun never throws, so one bad run cannot stop the rest.
  runAfterResponse(async () => {
    await Promise.allSettled(stale.map((run) => dispatchRun(run.id)));
  });

  return json({ scanned: ids.length, kicked: stale.length });
}

function isStalled(run: Run, cutoff: number): boolean {
  if (run.status === "done" || run.status === "failed") return false;
  if (run.status === "waiting_approval") return false;
  return run.updatedAt < cutoff;
}
