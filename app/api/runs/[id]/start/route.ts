import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Queues a draft run for the runner. Refused while any attachment is still uploading, so the
 * runner never starts a run without its files. Owner-only.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const store = getRunStore();
  const run = await store.getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);
  if (run.status !== "draft") return json({ error: "run is not a draft" }, 409);

  const files = await store.listRunFiles(run.id, { all: true });
  if (files.some((f) => !f.complete)) return json({ error: "an attachment is still uploading" }, 409);

  const now = Date.now();
  run.status = "queued";
  run.updatedAt = now;
  run.events.push({ at: now, message: "Run started" });
  await store.saveRun(run, { queue: true });
  return json(run, 202);
}
