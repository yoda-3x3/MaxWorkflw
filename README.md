# WorkflwPro

WorkflwPro runs a small team of Claude Code agents from a web dashboard. You type a task, an Orchestrator (Opus) plans it, Leads (Sonnet) and Workers (Haiku) carry it out, and you watch the agents live from any browser. Closing the tab does not stop a run.

WorkflwPro is built for one owner. It uses your own Claude subscription through a Claude Code OAuth token, not a per-call API key.

- **Stack:** Next.js 15 (App Router), React 19, TypeScript, hosted on Vercel.
- **State and queue:** Upstash Redis over REST.
- **Agent execution:** GitHub Actions (`.github/workflows/run.yml`) runs `scripts/runner.ts`, which drives `claude -p` (Claude Code).
- **Sign-in:** GitHub OAuth only. Only accounts in `ALLOWED_USERS` get in.

## Architecture

```
 browser ──► Vercel (Next.js)
               │  reads/writes run state, locks, queue
               ├──► Upstash Redis
               │
               │  workflow_dispatch (GITHUB_TOKEN, actions:write)
               ▼
        GitHub Actions: .github/workflows/run.yml   input: run_id
               │  npm ci, npm i -g @anthropic-ai/claude-code
               ▼
        scripts/runner.ts  ──► claude -p (Claude Code)
               │                 auth: CLAUDE_CODE_OAUTH_TOKEN
               │                 (owner's Claude subscription, no API key)
               ▼
        advances the run, writes state back to Upstash
```

1. **Vercel stores and queues.** The web app and API routes keep runs, agents, approvals, and logs in Upstash Redis. To advance a run, Vercel dispatches `run.yml` through the GitHub `workflow_dispatch` API with the run id as input.
2. **GitHub Actions does the work.** Each dispatch checks out this repo, installs dependencies, installs Claude Code, and runs `scripts/runner.ts` for that run id. The runner advances the run until it has nothing to do right now or its time budget is spent.
3. **Claude Code runs the agents.** Agent calls go through `claude -p` on the runner. The OAuth token bills the owner's Claude subscription. `ANTHROPIC_API_KEY` is ignored and removed if it is set.
4. **Vercel never runs model calls.** Vercel only stores state and dispatches jobs. Three things dispatch a run: opening it in the UI (when it has gone quiet for more than 90 seconds), an approval decision, and a daily cron. The cron re-dispatches runs idle for more than 3 minutes and skips runs that are waiting for approval.

Concurrency: the workflow uses one concurrency group per run id (`run-<id>`) with `cancel-in-progress: false`, so two dispatches for the same run queue instead of cancelling each other. The runner also takes a per-run lock in Redis.

## How a run works

1. Sign in with GitHub. Only allowlisted users get in.
2. Submit a task, optionally with a GitHub repo. The Orchestrator returns a JSON plan: `{summary, units:[{id,title,brief,deps,workers?}]}`.
3. Units with `workers` become a Lead with Haiku workers. Units without become a standalone Sonnet worker.
4. Each dispatch runs the engine until it has nothing to do right now (planning, a wave of ready agents, or finalizing), then stops. The next dispatch picks up where it left off.
5. Leads integrate their workers' reports. The Orchestrator writes a final report.
6. Risky actions pause only the agent that asked and show an Approve/Deny card. Everything else keeps going.

### Limits (enforced in code)

- At most **15 agents** per run, counted across all tiers. Plans over the cap are truncated and the cut is logged.
- At most **3 tiers**: Orchestrator, Lead, Worker.
- Each run has a **24-hour deadline**. A run past it fails with a clear message.
- Each agent gets one retry. After that it is marked failed, and the run continues and reports it.
- Repo mode writes only to its own branch, `workflwpro/<runId>`. It never merges, deletes, or force-pushes. You press Merge yourself.
- Writes block path traversal, `.git/`, and `.env*` files.

## Accounts you need

| Service | Why | Notes |
|---|---|---|
| Claude subscription | Model calls through Claude Code | Create the OAuth token with `claude setup-token`. No API key. |
| GitHub OAuth app | Sign-in | Callback URL: `https://workflwpro.vercel.app/api/auth/github/callback` |
| GitHub token (fine-grained) | Dispatch workflows and repo mode | Dispatch needs `actions: write` on this repo. Repo mode needs contents and pull requests on the repos you allow. |
| Upstash Redis | Run state, queue, locks | REST URL and token |
| Vercel | Hosting and cron | Hobby works. |

Creating any of these, and any key or secret, is a manual step for the owner.

## Setup

### 1. GitHub OAuth app

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage URL: `https://workflwpro.vercel.app`.
3. Authorization callback URL: `https://workflwpro.vercel.app/api/auth/github/callback`. It must match exactly.
4. Copy the client ID and generate a client secret. Put them in Vercel as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### 2. Claude Code OAuth token

```bash
npm i -g @anthropic-ai/claude-code
claude setup-token
```

Copy the printed token into the GitHub repo secret `CLAUDE_CODE_OAUTH_TOKEN`. Do not put it in Vercel.

### 3. Vercel environment variables

Set these in the Vercel project settings for production and preview:

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes | HMAC key for session cookies. At least 32 characters. `openssl rand -base64 32` |
| `CRON_SECRET` | yes | Bearer secret for `/api/cron/kick` only. `openssl rand -hex 32` |
| `ALLOWED_USERS` | yes | Comma-separated GitHub logins, case-insensitive. Empty denies everyone. |
| `GITHUB_CLIENT_ID` | yes | OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | yes | OAuth app client secret |
| `GITHUB_TOKEN` | yes | Fine-grained token with `actions: write` on the repo that holds `run.yml`. Used to dispatch runs. |
| `UPSTASH_REDIS_REST_URL` | yes | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | yes | Upstash REST token |
| `DISPATCH_REPO` | yes | `owner/name` of the repo that holds `run.yml` |
| `DISPATCH_WORKFLOW` | yes | Workflow file name, `run.yml` |
| `DISPATCH_REF` | yes | Branch to dispatch on, usually `main` |
| `TICKER_SYMBOLS` | no | Comma-separated tickers for the ticker bar, e.g. `AAPL,MSFT,NVDA`. Empty hides it. |
| `ORCHESTRATOR_MODEL` | no | Default `claude-opus-5-5` |
| `LEAD_MODEL` | no | Default `claude-sonnet-5-5` |
| `WORKER_MODEL` | no | Default `claude-haiku-5-5` |

### 4. GitHub repo secrets (Actions)

Set these under the repo's Settings → Secrets and variables → Actions:

| Secret | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. Bills the owner's Claude subscription. |
| `UPSTASH_REDIS_REST_URL` | Same Upstash database as Vercel. The runner reads and writes run state. |
| `UPSTASH_REDIS_REST_TOKEN` | Same Upstash token as Vercel |
| `GH_REPO_TOKEN` | Fine-grained token for repo mode: read, branch, commit, and open PRs on the allowed repos. |

Never set `ANTHROPIC_API_KEY` in Vercel or in Actions. Agents must bill through `CLAUDE_CODE_OAUTH_TOKEN`.

### 5. Deploy

Connect the repo to Vercel and deploy. Preview deploys are fine. Production deploys need your approval. Then open the site, sign in with GitHub, and start a run.

### Local development

```bash
npm install
cp .env.example .env.local   # fill in values; never commit .env.local
npm run dev                  # http://localhost:3000
```

Without Upstash variables, local dev uses an in-memory store. That state is lost on restart, and runs will not reach Actions unless the dispatch variables are set.

Other scripts:

- `npm run typecheck`: `tsc --noEmit`
- `npm test`: unit tests. They mock Claude, so they make no real calls.
- `npm run build`: production build
- `npm start`: serve the production build

## Safety rules

- **Secrets stay out of code, git, and the browser.** Never commit `.env*` files. Never put secrets in `NEXT_PUBLIC_*` variables.
- **No API keys.** Agents bill through `CLAUDE_CODE_OAUTH_TOKEN`. The runner deletes `ANTHROPIC_API_KEY` if it is present.
- **The agent's environment is an allowlist.** The `claude` child process gets only an allowlisted environment. It never receives `GH_REPO_TOKEN`, `UPSTASH_*`, `GITHUB_TOKEN`, `SESSION_SECRET`, or `CRON_SECRET`. `CLAUDE_CODE_OAUTH_TOKEN` is the only secret it sees. The runner also redacts known secret values from logs.
- **Only dispatches advance runs.** The workflow runs only on `workflow_dispatch`, so forks and other events never receive secrets.
- **Repo mode is write-limited.** Agents write to a run branch only. They never merge, delete, or force-push. You merge the PR yourself.
- **Approvals gate risky actions.** A risky action pauses the agent that asked until you approve or deny it.
- **Single user.** WorkflwPro is built for one owner and a short allowlist. It is not multi-tenant. Users can read only their own runs.

## What agents can and cannot do

- Agents can run code, but only through Claude Code inside the GitHub Actions runner. Code they run executes on that disposable runner, not on Vercel.
- The `claude` child gets `CLAUDE_CODE_OAUTH_TOKEN` as its only secret, so code an agent runs could read it. Treat the token as exposed to agent-run code. Use a token tied to your subscription that you can rotate, and review repo-mode PRs before you merge.
- Check generated code by reading it and running the tests yourself before you merge.

## Known limits

- **Actions time limits.** The workflow job has `timeout-minutes: 330`. The runner stops starting new steps after about 5 hours, so the last step finishes inside the job limit. Work that does not fit in one job continues in the next dispatch.
- **Run deadline.** Each run has a 24-hour deadline, counted from creation, whatever the number of dispatches.
- **Cron is daily on Vercel Hobby.** `vercel.json` schedules `/api/cron/kick` at `0 0 * * *`. That is a backup only. UI opens and approval decisions do most of the work. Pro allows more frequent cron.
- **Concurrency is one job per run.** A second dispatch for the same run waits for the first.
- **GitHub rate limits and Claude subscription limits** apply. A run that hits a limit retries later, or fails and reports the error.

## Residual risks

The env allowlist and the Bash deny-list reduce exposure. They do not make the runner a sandbox. Known gaps:

- **Same-user process reads.** The runner deletes `GH_REPO_TOKEN` and the Upstash variables from its own `process.env`, but deleting a variable only unsets it in that process. Agent-run code runs as the same Linux user, so it may still read the runner's environment through `/proc/<pid>/environ` and its memory. Treat `GH_REPO_TOKEN`, the Upstash credentials, and `CLAUDE_CODE_OAUTH_TOKEN` as readable by agent-run code.
- **The Bash deny-list is best-effort.** `--disallowedTools` blocks named patterns such as `Bash(git push:*)` and `Bash(gh:*)`. Shell code can reach the same actions by other routes (scripts, interpreters, `curl`). Do not rely on it to stop a determined agent.
- **Anyone with write access can dispatch.** Anyone who can run workflows on this repo can dispatch `run.yml` on any ref, and that job receives the repo secrets. Restrict write and Actions access to the repo. Consider a GitHub Environment with required reviewers that holds the secrets; `run.yml` does not reference one yet.
- **Scope the tokens.** Make `GH_REPO_TOKEN` a fine-grained personal access token limited to the repos you need, with contents and pull requests access only and no admin or delete rights. Limit the Vercel `GITHUB_TOKEN` to `actions: write` on the dispatch repo. Rotate tokens on a schedule and right away if you suspect exposure. Pin third-party Actions to commit SHAs instead of tags.
- **Review before merging.** Agent code writes the PR diff. Review it before you press Merge. The Merge step does not run tests or checks for you.

## API

All routes require a signed session, except `/api/auth/*`. The cron route accepts only `Authorization: Bearer $CRON_SECRET`.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/runs` | List your runs / create a run (`{task, repo?}`) |
| GET | `/api/runs/:id` | Full run: agents, approvals, log, tokens, deadline, PR, final report |
| POST | `/api/runs/:id/kick` | Dispatch the run from the UI if it has gone quiet for more than 90 seconds |
| POST | `/api/runs/:id/approvals/:approvalId` | `{decision: "approve" \| "deny"}`. Also dispatches the run. |
| POST | `/api/runs/:id/merge` | `{confirm: true}`. Owner only. Merges the PR. |
| GET | `/api/cron/kick` | Cron: dispatch runs idle for more than 3 minutes, skipping runs waiting for approval. `CRON_SECRET` only. |

## Repo layout

- `app/`: pages, layout, and API routes
- `components/`: UI, including the gesture layer
- `lib/`: shared types, auth, store, GitHub client, prompts, engine
- `scripts/runner.ts`: entry point for GitHub Actions. Advances one run.
- `scripts/lib/`: env checks, git workspace handling, loop, and log redaction
- `.github/workflows/run.yml`: the Actions workflow that runs the runner
- `vercel.json`: cron schedule and function durations
- `ORCHESTRATOR_PROMPT.md`: the Orchestrator's system prompt reference

## Gestures and camera mode

Optional hands-free control. Turn on camera mode from the dashboard and a small hand-tracking panel appears. Hand gestures map to dashboard actions: next or previous view, refresh, toggle sidebar, open detail, and fullscreen.

- Hand tracking runs **in your browser** using MediaPipe (`@mediapipe/tasks-vision`). Camera frames are processed locally and are **not uploaded**.
- The camera starts only after you turn camera mode on, and stops when you turn it off or leave the page.
- The app sets `Permissions-Policy: camera=(self)`, so only this site can request the camera.
- MediaPipe loads its WASM and model assets on first use from the asset host. Self-host them if that matters to you.
