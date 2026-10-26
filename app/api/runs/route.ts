import { buildRun } from "@/lib/engine";
import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TASK_CHARS = 8000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Run history plus whether the PC runner is online. One Upstash call each, in parallel. */
export async function GET(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  const store = getRunStore();
  const [runs, runner] = await Promise.all([store.listRunsForOwner(caller.id), store.getRunnerStatus()]);
  return json({ runs, runner: { online: runner.online } });
}

/**
 * Creates a draft run. Attachments can be uploaded while it is a draft; POST /api/runs/:id/start
 * queues it. Only signed-in users on ALLOWED_USERS get here (getCaller checks the allowlist).
 */
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

  const run = buildRun({ ownerId: caller.id, task, repo, draft: true });
  await getRunStore().saveRun(run);
  return json(run, 201);
}
