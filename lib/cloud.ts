// Starts the cloud runner: a GitHub Actions job (.github/workflows/cloud-runner.yml) that works
// the cloud queue with Claude Code on the owner's subscription, then exits. The repo is public, so
// Actions minutes are free. Needs GITHUB_TOKEN with Actions: Read and write on CLOUD_RUNNER_REPO.

export const CLOUD_WORKFLOW = "cloud-runner.yml";
export const DEFAULT_CLOUD_REPO = "yoda-3x3/MaxWorkflw";

export interface DispatchResult {
  ok: boolean;
  /** Why it failed, in words the owner can act on. */
  error?: string;
}

export async function dispatchCloudRunner(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<DispatchResult> {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: "GITHUB_TOKEN is not set on the site, so it can't start a cloud runner." };
  const repo = env.CLOUD_RUNNER_REPO || DEFAULT_CLOUD_REPO;
  const res = await fetchFn(`https://api.github.com/repos/${repo}/actions/workflows/${CLOUD_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "WorkflwPro",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main" }),
  }).catch((err: unknown) => ({ ok: false, status: 0, text: async () => String(err) }) as unknown as Response);
  if (res.ok) return { ok: true };
  const detail = (await res.text().catch(() => "")).slice(0, 200);
  if (res.status === 403 || res.status === 404) {
    return {
      ok: false,
      error: `GitHub refused to start the cloud runner (${res.status}). Give the GITHUB_TOKEN "Actions: Read and write" on ${repo}.`,
    };
  }
  return { ok: false, error: `Couldn't start the cloud runner (${res.status || "network error"}): ${detail}` };
}
