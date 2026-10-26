import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; fileId: string }> };

/**
 * Marks an attachment complete once every chunk is stored. 409 with the missing count otherwise,
 * so the UI can retry the chunks it lost. Draft runs only.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id, fileId } = await params;
  const store = getRunStore();
  const run = await store.getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);
  if (run.status !== "draft") return json({ error: "attachments can only be completed on a draft run" }, 409);

  const file = await store.getRunFile(run.id, fileId);
  if (!file) return json({ error: "not found" }, 404);
  if (file.complete) return json(file);

  const missing = await store.completeRunFile(run.id, fileId);
  if (missing > 0) return json({ error: "chunks are missing", missing }, 409);
  return json({ ...file, complete: true });
}
