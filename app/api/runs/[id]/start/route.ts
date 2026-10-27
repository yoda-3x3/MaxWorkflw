import { dispatchCloudRunner } from "@/lib/cloud";
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

  // Where it runs: the owner's choice, or for auto the PC when its runner is online, else the cloud.
  const runOn = run.options?.runOn ?? "auto";
  const placement =
    runOn === "pc" ? "pc" : runOn === "cloud" ? "cloud" : (await store.getRunnerStatus()).online ? "pc" : "cloud";

  const now = Date.now();
  run.status = "queued";
  run.placement = placement;
  run.updatedAt = now;
  run.events.push({ at: now, message: placement === "cloud" ? "Run started on the cloud runner" : "Run started on your PC" });
  await store.saveRun(run, { queue: true });
  if (placement === "cloud") {
    const started = await dispatchCloudRunner();
    if (!started.ok) {
      run.events.push({ at: Date.now(), message: started.error ?? "Couldn't start the cloud runner." });
      await store.saveRun(run);
      return json({ ...run, cloudError: started.error }, 202);
    }
  }
  return json(run, 202);
}
