# WorkflwPro

WorkflwPro runs a small team of Claude Code agents from a web dashboard. You type a task, an Orchestrator (Opus) plans it, Leads (Sonnet) and Workers (Haiku) carry it out, and you watch the agents live from any browser. Closing the tab does not stop a run.

WorkflwPro is built for one owner. It uses your own Claude subscription through a Claude Code OAuth token, not a per-call API key.

- **Stack:** Next.js 15 (App Router), React 19, TypeScript, OpenNext, hosted on Cloudflare Workers.
- **State and queue:** Upstash Redis over REST.
- **Agent execution:** a scheduled task on your PC runs `scripts/runner.ts`, which drives Claude Code through the Claude Agent SDK.
- **Sign-in:** GitHub OAuth only. Only accounts in `ALLOWED_USERS` get in.

## Architecture

```
 browser ──► Cloudflare Worker (OpenNext: Next.js + static assets)
               │  reads/writes run state, locks, queue
               ▼
          Upstash Redis  ◄──────────────────────────┐
                                                    │ reads/writes run state
        PC scheduled task: scripts/runner.ts        │
               │  advances one run per tick         │
               ├──► Claude Agent SDK (CLAUDE_CODE_OAUTH_TOKEN,
               │     owner's subscription, no API key)
               └──► git/gh on the PC (the PC's own GitHub credentials)
```

1. **The Worker stores and serves.** The web app and API routes keep runs, agents, approvals, and logs in Upstash Redis. The Worker never runs model calls.
2. **The PC runner does the work.** A Windows scheduled task starts `scripts/runner.ts`. It picks up active runs from Upstash, advances them until they have nothing to do right now or the time budget is spent, and writes state back.
3. **Claude Code runs the agents.** Agent calls go through the Claude Agent SDK on the PC. The OAuth token bills the owner's Claude subscription. `ANTHROPIC_API_KEY` is ignored and removed if it is set.

## Setup

### 1. Cloudflare Worker

Prerequisites: Node 20 or newer, a Cloudflare account, and `npx wrangler login` once.

```bash
npm install
npm run cf:build        # OpenNext build into .open-next/
npm run preview         # build and run locally with workerd
npm run deploy          # build, then deploy to workflwpro.flitetest-bhs.workers.dev
```

Non-secret settings live in `wrangler.jsonc` under `vars`: `APP_ORIGIN`, `ALLOWED_USERS`, `TICKER_SYMBOLS`. Change them there and redeploy.

Secrets are never in `wrangler.jsonc`. Set each one once, then redeploy if you change it:

```bash
npx wrangler secret put SESSION_SECRET          # openssl rand -base64 32
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

```bash
npx wrangler secret put GITHUB_TOKEN            # used by the merge route
```

`.env.example` lists every name, with the Worker vars and secrets separated.

For local development, copy `.env.example` to `.dev.vars` and fill it in. `.dev.vars` is git-ignored. `CLAUDE_CODE_OAUTH_TOKEN` is never a Worker secret.

### 2. PC runner (`runner.env`)

The runner reads its env from `scripts/.env` or `runner.env` in the repo root. Both are git-ignored and must never be committed. Process env wins over both files. Copy the runner block from `.env.example`:

```
CLAUDE_CODE_OAUTH_TOKEN=     # from `claude setup-token`
UPSTASH_REDIS_REST_URL=      # same database as the Worker
UPSTASH_REDIS_REST_TOKEN=
```

The runner uses the PC's own `git` and `gh` credentials to reach GitHub, so no GitHub token goes in this file.

### 3. Scheduled task (Windows)

`scripts/install-runner-task.ps1` registers the runner as a hidden Windows scheduled task named `WorkflwProRunner`. It starts at logon, restarts on failure, and runs `npx tsx scripts/runner.ts` in the repo. Run it from PowerShell in the repo root:

```powershell
.\scripts\install-runner-task.ps1               # install (or update) and start the task
.\scripts\install-runner-task.ps1 -Start        # start it now
.\scripts\install-runner-task.ps1 -Stop         # stop it (it restarts at next logon)
.\scripts\install-runner-task.ps1 -Uninstall    # stop and remove the task
```

The task only runs while the PC is on and you are logged in. The install step warns if neither env file exists.

### HandCam (MediaPipe)

The gesture model and WASM are loaded from a CDN at runtime (`components/handcam/HandCamToggle.tsx`), not bundled into the Worker. That keeps the Worker bundle small. The browser needs internet access to the CDN when HandCam is turned on. No file goes in `public/`.

## How a run works

1. Sign in with GitHub. Only allowlisted users get in.
2. Submit a task, optionally with a GitHub repo. The Orchestrator returns a JSON plan: `{summary, units:[{id,title,brief,deps,workers?}]}`.
3. Units with `workers` become a Lead with Haiku workers. Units without become a standalone Sonnet worker.
4. Each runner tick advances the engine until it has nothing to do right now (planning, a wave of ready agents, or finalizing), then stops. The next tick picks up where it left off.
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
| Cloudflare | Hosts the Worker | Workers Free plan works. |
| Upstash | Run state, locks, queue | Free tier is enough for one owner. Use REST URL and token. |
| GitHub | Sign-in (OAuth app) | Callback URL: `https://workflwpro.flitetest-bhs.workers.dev/api/auth/github/callback`. |

## Free-tier notes

- **Workers Free:** 100,000 requests per day and a 10 ms CPU limit per request. Model calls never run on the Worker, so this is rarely hit.
- **Worker size:** the free plan caps a Worker at 3 MB compressed. Run `npx wrangler deploy --dry-run --outdir=.wrangler-dry` to see the size. The build keeps HandCam and other heavy code out of the bundle.
- **Upstash free:** limited daily commands. The runner and UI poll only while a run is active.
- **No cron.** Nothing on Cloudflare schedules work. The PC task is the only driver. If the PC is off, runs wait.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server (no Cloudflare bindings) |
| `npm run cf:build` | OpenNext build for Workers into `.open-next/` |
| `npm run preview` | Build, then run locally on workerd |
| `npm run deploy` | Build, then deploy to Cloudflare |
| `npm run runner` | Run the PC runner once, in the foreground |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript check |

## Layout

- `app/`: Next.js pages and API routes (Worker-compatible, no `fs` or `child_process`)
- `lib/`: engine, store, auth, LLM wiring. `lib/claude-cli.ts` is runner-only.
- `scripts/runner.ts`: PC runner entry point. Advances one run per tick.
- `scripts/install-runner-task.ps1`: installs the scheduled task
- `wrangler.jsonc`: Worker config
- `open-next.config.ts`: OpenNext adapter config
- `middleware.ts`: session check on pages and API routes

## Security notes

- **No API keys.** Agents bill through `CLAUDE_CODE_OAUTH_TOKEN`. The runner deletes `ANTHROPIC_API_KEY` if it is present.
- **Secrets stay where they belong.** Worker secrets are set with `wrangler secret put`. `CLAUDE_CODE_OAUTH_TOKEN` lives only in `runner.env` on the PC.
- **Agent environment is an allowlist.** The Claude child process gets only an allowlisted environment and `CLAUDE_CODE_OAUTH_TOKEN`. The runner redacts known secret values from logs.
- The env allowlist and Bash deny-list reduce exposure. They do not make the PC runner a sandbox. Agents can run code on your PC through Claude Code, with your user's permissions. Keep the scheduled task on an account you trust.
