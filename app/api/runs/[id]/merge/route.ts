import { createGitHubClient } from "@/lib/github";
import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Merges the run's PR. Owner-only and guarded by an explicit `confirm: true` from the UI's
 * confirm dialog. This is the only code path that merges, and it never deletes or force-pushes.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const { id } = await params;
  const run = await getRunStore().getRun(caller.id, id);
  if (!run) return json({ error: "not found" }, 404);

  const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== true) return json({ error: "confirm: true is required" }, 400);

  if (!run.repo || run.prNumber === undefined) {
    return json({ error: "run has no pull request" }, 409);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) return json({ error: "GITHUB_TOKEN is not configured" }, 500);

  const [owner, repo] = run.repo.split("/");
  try {
    const github = createGitHubClient({ owner, repo, token });
    const result = await github.mergePR(run.id, { prNumber: run.prNumber, explicit: true });
    if (!result.merged) return json({ error: "GitHub did not merge the pull request" }, 502);
    return json({ merged: true, sha: result.sha, prUrl: run.prUrl });
  } catch (err) {
    return json({ error: `merge failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
}
