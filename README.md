# WorkflwPro

WorkflwPro runs a small team of Claude Code agents from a web dashboard. You type a task, an Orchestrator (Opus) plans it, Leads (Sonnet) and Workers (Haiku) carry it out, and you watch the agents live from any browser. Closing the tab does not stop a run: the PC runner keeps working on it.

WorkflwPro is built for one owner. It uses your own Claude subscription through a Claude Code OAuth token, not a per-call API key.

- **Stack:** Next.js 15 (App Router), React 19, TypeScript, OpenNext, hosted on Cloudflare Workers.
- **State and queue:** Upstash Redis over REST.
- **Agent execution:** a Windows scheduled task on your PC runs `scripts/runner.ts`, which drives Claude Code through the Claude Agent SDK.
- **Sign-in:** GitHub OAuth only. Only accounts in `ALLOWED_USERS` get in.

## Architecture

```
 browser ──► Cloudflare Worker (OpenNext: Next.js + static assets)
               │  reads/writes runs, agents, approvals, logs, locks
               ▼
          Upstash Redis  ◄──────────────────────────┐
                                                    │ claims runs, writes progress
        PC: scheduled task → scripts/runner.ts ─────┘
               │  heartbeat every 15 s (45 s TTL)
               ├──► Claude Agent SDK  (CLAUDE_CODE_OAUTH_TOKEN, your subscription)
               └──► gh / git on the PC  (repo mode only)
```

1. **The Worker stores and serves.** The web app and API routes keep runs, agents, approvals, and logs in Upstash Redis. The Worker never runs model calls and has no cron.
2. **The PC runner does the work.** It polls Upstash for queued runs (every 15 s when idle, every 2 s when busy), claims one, and advances it until nothing is runnable right now. Then it releases the run and goes back to polling.
3. **Claude Code runs the agents.** Model calls go through the Claude Agent SDK on the PC and bill your subscription. `ANTHROPIC_API_KEY` is ignored and removed if it is set.
4. **The dashboard watches the heartbeat.** The runner writes a heartbeat key every 15 seconds. If it expires, the dashboard shows "PC runner offline."

## Accounts you need

| Account | Used for | Notes |
|---|---|---|
| Cloudflare | Hosts the Worker | Workers Free plan works. Run `npx wrangler login` once. |
| Upstash | Run state, queue, locks, heartbeat | Free Redis database. The Worker and the runner both use it. |
| GitHub | Sign-in (OAuth app) and the Merge button (token) | OAuth app for sign-in. A fine-grained token for Merge. |
| Claude subscription | Agent model calls | Create the OAuth token with `claude setup-token`. No API key. |

## Setup

### 1. Upstash database

1. Create a free Redis database in the Upstash console.
2. Copy its REST URL and REST token.
3. Use the same values in two places: the Worker secrets (step 4) and the runner env file (step 6).

### 2. GitHub OAuth app and token

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage URL: `https://workflwpro.pages.dev`
3. Authorization callback URL: `https://workflwpro.pages.dev/api/auth/github/callback`. The callback is built from `APP_ORIGIN`, so the two must match exactly.
4. Copy the client ID and generate a client secret. You will set both in step 4.
5. Create a fine-grained personal access token for the Merge button and the repo picker. Give it contents and pull requests read and write on the repos you use with repo mode, plus metadata read (GitHub adds this automatically). The repo picker lists the repos this token can reach, so include every repo you want to pick. You will set it as `GITHUB_TOKEN` in step 4.
   - "Create new repo" in the sidebar asks GitHub to create a repo under the token's account. Fine-grained tokens may not be allowed to create repos. If creation fails with a permission message, use a classic token with the `repo` scope, or create the repo on GitHub and pick it from the list.
   - The OAuth sign-in only asks for `read:user`. The repo list and repo creation use `GITHUB_TOKEN`, not the signed-in user's own GitHub token, so they show what that one token can reach.

### 3. Worker vars (`wrangler.jsonc`)

Non-secret settings live under `vars` in `wrangler.jsonc`:

```jsonc
"vars": {
  "APP_ORIGIN": "https://workflwpro.pages.dev",
  "ALLOWED_USERS": "your-github-login",
  "TICKER_SYMBOLS": "AAPL,MSFT,NVDA"
}
```

| Var | Required | Purpose |
|---|---|---|
| `APP_ORIGIN` | yes | Public origin of the Worker. The OAuth callback is built from it. |
| `ALLOWED_USERS` | yes | Comma-separated GitHub logins, case-insensitive. Empty denies everyone. |
| `TICKER_SYMBOLS` | no | Comma-separated tickers for the ticker bar. Empty hides it. |
| `ORCHESTRATOR_MODEL`, `LEAD_MODEL`, `WORKER_MODEL` | no | Model IDs. Defaults: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. Only the runner calls models, so set overrides in the runner env file (step 6) for them to take effect. |

Change a var, then run `npm run deploy`.

### 4. Worker secrets (`wrangler secret put`)

Run these from the repo root. Each command prompts for the value, so nothing is written to a file:

```bash
npx wrangler secret put SESSION_SECRET          # openssl rand -base64 32
npx wrangler secret put GITHUB_CLIENT_ID        # step 2
npx wrangler secret put GITHUB_CLIENT_SECRET    # step 2
npx wrangler secret put GITHUB_TOKEN            # step 2, used by the Merge button
npx wrangler secret put UPSTASH_REDIS_REST_URL  # step 1
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

Secrets never go in `wrangler.jsonc` or git. `CLAUDE_CODE_OAUTH_TOKEN` is never a Worker secret. It stays on the PC.

### 5. Build, preview, and deploy

```bash
npm install
npm run cf:build        # OpenNext build into .open-next/
npm run preview         # build and run locally on workerd
npm run deploy          # build, then deploy to Cloudflare
npm run deploy:pages    # the workflwpro.pages.dev front door
```

The app runs in the `workflwpro` Worker. `https://workflwpro.pages.dev` is a Cloudflare Pages project (`pages-proxy/`) that forwards every request to that Worker through a service binding, so deploy the Worker first. `deploy:pages` only needs re-running if `pages-proxy/` changes.

For local preview, copy the Worker block from `.env.example` to `.dev.vars` (git-ignored) and fill it in. Then open `APP_ORIGIN`, sign in with GitHub, and start a run once the runner is up (step 6).

### 6. PC runner env file (`runner.env`)

1. Install Claude Code, then create the token: `npm i -g @anthropic-ai/claude-code`, then `claude setup-token`. Copy the printed token.
2. In the repo root, create `runner.env` (or `scripts/.env`). Both are git-ignored:

   ```
   CLAUDE_CODE_OAUTH_TOKEN=     # from claude setup-token
   UPSTASH_REDIS_REST_URL=      # same database as the Worker
   UPSTASH_REDIS_REST_TOKEN=
   ```

   Model overrides (`ORCHESTRATOR_MODEL` and so on) go here too, if you want them. `scripts/.env` wins over `runner.env` for any key that appears in both. Real environment variables win over both files.

3. Repo mode uses the PC's own GitHub CLI login, so no GitHub token goes in the file. Run `gh auth login` once on the PC. Only runs with a repo need it.
4. Run `npm install` in the repo once.
5. Test the runner in the foreground: `npm run runner`. A line saying the runner is up means it is polling. Press Ctrl+C to stop it.

The runner never logs secret values. If a required key is missing, it names the key and exits.

### 7. Scheduled task (Windows)

`scripts/install-runner-task.ps1` registers the runner as a hidden Windows scheduled task named `WorkflwProRunner`. The task starts at logon, restarts on failure, and runs `npx tsx scripts/runner.ts` in the repo. Run it from PowerShell in the repo root:

```powershell
.\scripts\install-runner-task.ps1               # install (or update) and start the task
.\scripts\install-runner-task.ps1 -Start        # start it now
.\scripts\install-runner-task.ps1 -Stop         # stop it now (it restarts at next logon)
.\scripts\install-runner-task.ps1 -Uninstall    # stop and remove the task
```

Notes:

- The task runs only while the PC is on and you are logged in.
- The install step warns if neither env file exists. Create one first (step 6).
- The task points at this repo folder. If you move the repo, run `-Uninstall`, then reinstall from the new location.

### HandCam (optional gesture control)

HandCam loads the MediaPipe WASM and gesture model from a CDN when you turn it on (`components/handcam/HandCamToggle.tsx`). Nothing is bundled into the Worker and nothing goes in `public/`. The browser needs internet access to the CDN when HandCam is on. Camera frames are processed in the browser and are not uploaded.

## How a run works

1. Sign in with GitHub. Only allowlisted users get in.
2. Submit a task, optionally with a GitHub repo. The Orchestrator returns a JSON plan: `{summary, units:[{id,title,brief,deps,workers?}]}`.
3. Units with `workers` become a Lead with Haiku workers. Units without become a standalone Sonnet worker.
4. The runner advances the run until nothing is runnable right now (planning, a wave of ready agents, or finalizing). It has no time budget. If the runner is stopped mid-run, the run is requeued for the next runner.
5. Leads integrate their workers' reports. The Orchestrator writes a final report.
6. Risky actions pause only the agent that asked and show an Approve/Deny card. Everything else keeps going.

### Limits (enforced in code)

- At most **30 agents** per run, counted across all tiers. Plans over the cap are truncated and the cut is logged.
- At most **3 tiers**: Orchestrator, Lead, Worker.
- Each run has a **24-hour deadline**. A run past it fails with a clear message.
- Each agent gets **one retry** (two attempts in total). After that it is marked failed, and the run continues and reports it.
- Repo mode works only on its own branch, `workflwpro/<runId>`. It never merges, deletes, or force-pushes. You press Merge yourself.
- Pick the repo in the sidebar's **Repo** field. Type `owner/name` by hand, or search the list (type to filter, arrow keys and Enter to choose, **Load more** for more pages). The list shows private/public and the default branch. Only the first 1,000 repos are searched.
- **Create new repo** makes a new repo under the token's account with an initial commit, so it has a default branch. It is private unless you untick Private. The name is checked before GitHub is called. Nothing is ever deleted.
- For an existing repo, the PC runner clones it, branches `workflwpro/<runId>` from the default branch, or reuses that branch if an earlier job pushed it. The run's PR targets the default branch. Repo mode needs `gh auth login` on the PC, and the PC account needs push access to the repo.
- Writes block path traversal, `.git/`, and `.env*` files.

### File uploads

- A run can take attachments of up to about **90 MB** in total. That cap is set by the free Worker and Upstash setup. A 20 GB limit is not possible on the free plan.
- Files are sent through the site in chunks, because one request cannot carry that much.
- The PC runner downloads the attachments into its work folder for the run.
- Attachments are deleted from Upstash after the runner downloads them, and in any case after 24 hours.

## Free-tier notes

- **Workers Free:** 100,000 requests per day and a 10 ms CPU limit per request. The Worker only serves pages and API calls, so this is rarely hit.
- **Worker size:** the Free plan caps a Worker at 3 MB compressed. HandCam's MediaPipe code loads from a CDN, which keeps the bundle small.
- **Upstash free:** the dashboard polls every 3 seconds while it is open, and the runner polls while it is up. Close the tab when you are done.
- **No cron.** Nothing on Cloudflare schedules work. The PC task is the only driver. If the PC is off, runs wait.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server (no Cloudflare bindings) |
| `npm run cf:build` | OpenNext build for Workers into `.open-next/` |
| `npm run preview` | Build, then run locally on workerd |
| `npm run deploy` | Build, then deploy to Cloudflare |
| `npm run runner` | Run the PC runner in the foreground. Ctrl+C stops it. |
| `npm test` | Unit tests |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

- `app/`: Next.js pages and API routes
- `components/`: dashboard UI, gestures, HandCam, ticker
- `lib/`: engine, store, auth, GitHub client, LLM wiring. `lib/claude-cli.ts` holds the agent env allowlist and Bash deny-list, which the runner uses.
- `scripts/runner.ts`: PC runner entry point
- `scripts/install-runner-task.ps1`: installs, starts, stops, or removes the scheduled task
- `wrangler.jsonc`: Worker config and non-secret vars
- `open-next.config.ts`: OpenNext adapter config
- `middleware.ts`: session check on pages and API routes

## Troubleshooting

### "PC runner offline." banner

The dashboard shows this when the runner's heartbeat has been missing for 45 seconds. Runs stay queued until the runner comes back.

1. Is the task running? In PowerShell: `Get-ScheduledTask -TaskName WorkflwProRunner`. If it is not running, start it with `.\scripts\install-runner-task.ps1 -Start`.
2. Run `npm run runner` in the repo to see errors live. A `missing required env` message names the keys to add to `runner.env`.
3. Check the Upstash values. The runner needs the same database and token as the Worker. If it cannot reach Upstash, it cannot write the heartbeat, and the banner stays up.
4. The task runs only while the PC is on and you are logged in. A sleeping or logged-out PC shows the banner.

### Sign-in fails or says denied

- Your GitHub login is not in `ALLOWED_USERS`. The match is case-insensitive, and an empty list denies everyone. Edit the var, then run `npm run deploy`.
- GitHub reports a redirect URI mismatch. The callback URL in the OAuth app must equal `APP_ORIGIN` plus `/api/auth/github/callback`.

### The repo list says it is unavailable, or Create new repo fails

- "GITHUB_TOKEN is not configured": set it with `npx wrangler secret put GITHUB_TOKEN`. You can still type `owner/name` by hand.
- "GitHub rejected GITHUB_TOKEN" or a 401: the token has expired or was revoked. Create a new one (step 2.5) and set it again.
- "GitHub would not create the repo" or a 403: the token cannot create repos. Use a classic token with the `repo` scope, or create the repo on GitHub and pick it.
- "You already have a repo named …": pick another name, or select the existing repo from the list.

### Repo-mode run fails with "no gh token for GitHub access"

Run `gh auth login` on the PC. The runner reads the token for each run, so no restart is needed.

### Merge fails with "GITHUB_TOKEN is not configured"

The secret is missing. Set it with `npx wrangler secret put GITHUB_TOKEN`.

### The Worker reports that Upstash variables are required

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` as Worker secrets (step 4).

## Security notes

- **No API keys.** Agents bill through `CLAUDE_CODE_OAUTH_TOKEN`. The runner deletes `ANTHROPIC_API_KEY` if it is present.
- **Secrets stay where they belong.** Worker secrets are set with `wrangler secret put`. `CLAUDE_CODE_OAUTH_TOKEN` lives only in the runner env file on the PC.
- **The agent environment is an allowlist.** The agent process gets only a short list of variables (`PATH`, `HOME`, and similar) plus `CLAUDE_CODE_OAUTH_TOKEN`. The runner redacts known secret values from logs.
- **The allowlist and Bash deny-list are not a sandbox.** Agents run code on your PC with your user's permissions. Keep the scheduled task on an account you trust, and review repo-mode work before you press Merge.
