import { dispatchRun, isCronAuthorized, json, runAfterResponse } from "@/lib/session";
import { getRunStore } from "@/lib/store";
import { selectStale } from "./select";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How many active run ids to read per tick before filtering for stale ones. */
const SCAN_LIMIT = 500;

/**
 * Backup driver for stalled runs (Vercel cron, Bearer CRON_SECRET). Dispatches the oldest
 * active runs that have not been updated recently. See select.ts for the rules.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return json({ error: "unauthorized" }, 401);

  const store = getRunStore();
  const ids = await store.listActiveRunIds(SCAN_LIMIT);
  const runs = await Promise.all(ids.map((id) => store.getRunForEngine(id)));
  const stale = selectStale(runs, Date.now());

  // dispatchRun never throws, so allSettled only keeps the rest going if one ever rejects.
  runAfterResponse(async () => {
    await Promise.allSettled(stale.map((run) => dispatchRun(run.id)));
  });

  return json({ scanned: ids.length, kicked: stale.length });
}
