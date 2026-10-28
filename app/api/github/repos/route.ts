import { getCaller, json } from "@/lib/session";
import {
  createAccessibleRepo,
  listAccessibleRepos,
  parseRepoListQuery,
  selectRepoPage,
  validateNewRepo,
  type NewRepoInput,
} from "@/lib/githubRepos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One page of the repos the server's GITHUB_TOKEN can access, filtered by ?q=. Signed-in users only.
 * The token is read from the server env, never returned to the browser, and never logged.
 */
export async function GET(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const token = process.env.GITHUB_TOKEN;
  if (!token) return json({ error: "GITHUB_TOKEN is not configured, so the repo list is unavailable. Type owner/name instead." }, 503);

  const query = parseRepoListQuery(new URL(req.url).searchParams);
  try {
    const { repos, truncated } = await listAccessibleRepos({ token });
    return json(selectRepoPage(repos, query, truncated), 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return json({ error: `Could not load repos from GitHub: ${message}` }, 502);
  }
}

/**
 * Creates a new repo under the token's account (private unless `private: false`). Never deletes.
 * Body: { name, description?, private? }. Returns the created repo as owner/name.
 */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const token = process.env.GITHUB_TOKEN;
  if (!token) return json({ error: "GITHUB_TOKEN is not configured, so repos cannot be created here." }, 503);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "send a JSON body with a name" }, 400);
  const input: NewRepoInput = {
    name: typeof body.name === "string" ? body.name.trim() : "",
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    private: body.private === undefined ? true : (body.private as boolean),
  };
  const invalid = validateNewRepo(input);
  if (invalid) return json({ error: invalid }, 400);

  try {
    const repo = await createAccessibleRepo(input, { token });
    return json(repo, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    const status = err instanceof Error && "status" in err && err.status === 422 ? 409 : 502;
    return json({ error: message }, status);
  }
}
