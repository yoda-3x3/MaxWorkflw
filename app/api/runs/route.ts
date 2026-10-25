import { createRun } from "@/lib/engine";
import { getCaller, json, scheduleKick } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TASK_CHARS = 8000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function GET(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  return json({ runs: await getRunStore().listRunsForOwner(caller.id) });
}

export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => null)) as { task?: unknown; repo?: unknown } | null;
  const task = typeof body?.task === "string" ? body.task.trim() : "";
  if (!task) return json({ error: "task is required" }, 400);
  if (task.length > MAX_TASK_CHARS) {
    return json({ error: `task must be at most ${MAX_TASK_CHARS} characters` }, 400);
  }

  let repo: string | undefined;
  if (body?.repo !== undefined && body.repo !== null && body.repo !== "") {
    if (typeof body.repo !== "string" || !REPO_PATTERN.test(body.repo)) {
      return json({ error: "repo must be in owner/name form" }, 400);
    }
    repo = body.repo;
  }

  const run = await createRun({ ownerId: caller.id, task, repo });
  scheduleKick(new URL(req.url).origin, run.id);
  return json(run, 201);
}
