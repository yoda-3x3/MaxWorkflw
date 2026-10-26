import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; fileId: string }> };

/** Removes an attachment and its chunks. Draft runs only. */
export async function DELETE(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id, fileId } = await params;
  const store = getRunStore();
  const run = await store.getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);
  if (run.status !== "draft") return json({ error: "attachments can only be removed from a draft run" }, 409);
  if (!(await store.deleteRunFile(run.id, fileId))) return json({ error: "not found" }, 404);
  return new Response(null, { status: 204 });
}
