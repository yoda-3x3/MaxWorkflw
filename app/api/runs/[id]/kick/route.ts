import { scheduleKick, getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const TERMINAL = new Set(["done", "failed"]);

/** UI backup driver: opening a run re-kicks it. The step route's lock makes duplicates harmless. */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const run = await getRunStore().getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);
  if (TERMINAL.has(run.status)) return json({ status: run.status, kicked: false });

  scheduleKick(new URL(req.url).origin, run.id);
  return json({ status: run.status, kicked: true }, 202);
}
