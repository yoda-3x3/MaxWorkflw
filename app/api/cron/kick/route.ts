import { isCronAuthorized, json, kickStep, runAfterResponse } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Caps the fan-out per invocation. The next cron tick picks up anything left over. */
const MAX_KICKS = 20;

/**
 * Backup driver for stalled runs (Vercel cron, Bearer CRON_SECRET). Re-kicks every active run.
 * Steps are idempotent under the run lock, so a run that is already progressing just answers 409.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return json({ error: "unauthorized" }, 401);

  const ids = await getRunStore().listActiveRunIds(MAX_KICKS);
  const origin = new URL(req.url).origin;
  // Each kick awaits only the step route's 202, so waiting on all of them inside after() is cheap.
  runAfterResponse(async () => {
    await Promise.allSettled(ids.map((id) => kickStep(origin, id)));
  });
  return json({ kicked: ids.length });
}
