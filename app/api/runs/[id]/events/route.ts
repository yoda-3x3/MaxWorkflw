import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MAX_PAGE = 200;

/**
 * Progress events the runner has written for this run. `from` is the index to read from (the
 * `next` value of the previous response). Owner-only.
 */
export async function GET(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const store = getRunStore();
  const run = await store.getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);

  const from = Number(new URL(req.url).searchParams.get("from") ?? "0");
  const start = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
  return json(await store.readProgress(run.id, start, MAX_PAGE));
}
