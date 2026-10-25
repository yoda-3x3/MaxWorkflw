import { step } from "@/lib/engine";
import { isCronAuthorized, json, kickStep, runAfterResponse } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** after() work counts toward this limit, so it covers one step plus the chained dispatch. */
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Only the exact CRON_SECRET bearer may call this: a user session cookie or any other
 * Authorization header gets 401. It answers 202 at once and does the step in after(). When the
 * step leaves work to do, it awaits the chained dispatch. That callee answers 202 immediately, so
 * invocations never nest. The engine takes the per-run lock itself, so a held lock is a no-op.
 */
export async function POST(req: Request, { params }: Ctx) {
  if (!isCronAuthorized(req)) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const origin = new URL(req.url).origin;
  runAfterResponse(async () => {
    try {
      const result = await step(id);
      if (result.more) await kickStep(origin, id);
    } catch (err) {
      console.error(`step ${id} failed`, err);
    }
  });
  return json({ accepted: true }, 202);
}
