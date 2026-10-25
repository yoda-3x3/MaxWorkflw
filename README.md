# MaxWorkflw

A web app that runs a 3-tier agent team from any browser: you type a task (optionally with a GitHub repo), an Orchestrator (Opus) plans it, Leads (Sonnet) and Workers (Haiku) carry it out, and you watch the wall of agents live. Runs execute in the cloud, so closing the tab does not stop them.

- **Stack:** Next.js 15 (App Router), React 19, TypeScript, deployed on Vercel.
- **Engine:** the Anthropic Messages API, called with `fetch`.
- **State:** Upstash Redis over REST. An in-memory fallback exists for local dev only.

## How a run works

1. Sign in (GitHub or emailed magic link). Only allowlisted users get in.
2. Submit a task. The Orchestrator returns a JSON plan: `{summary, units:[{id,title,brief,deps,workers?}]}`.
3. Units with `workers` become a Lead with Haiku workers. Units without become a standalone Sonnet worker.
4. Work runs in short serverless steps (plan, one wave of ready agents, or finalize). Each step triggers the next. A per-run lock stops two steps from driving one run.
5. Leads integrate their workers' reports. The Orchestrator writes a final report.
6. Risky actions pause only the agent that asked, and show an Approve/Deny card. Everything else keeps going.

### Limits (enforced in code)

- At most **15 agents** per run, counted across all tiers. Plans over the cap are truncated and the cut is logged.
- At most **3 tiers**: Orchestrator, Lead, Worker.
- Each run has a **24-hour deadline**. A run past it fails with a clear message.
- Each agent gets one retry. After that it is marked failed, and the run continues and reports it.
- Repo mode writes only to branch `maxworkflw/<runId>`. It never merges, deletes, or force-pushes. You press Merge yourself.
- Writes block path traversal, `.git/`, and `.env*`.

### What agents cannot do

**Agents cannot execute code.** There is no sandbox. "Verified" in a report means *reviewed*, not *run*. Reports say so rather than faking test results. Check any generated code by running it yourself.

### Vercel Hobby limits

- Hobby functions have short time limits. The step route requests `maxDuration: 300`, but Hobby may cap it lower. Runs still progress, just in more steps.
- Hobby crons run **once per day only**. `vercel.json` uses `0 0 * * *`. The cron is a backup; the UI kick and the step chaining do most of the work. **Pro is recommended** for long runs and a more frequent cron.

## Accounts you need

| Service | Why | Notes |
|---|---|---|
| Anthropic | Model calls (`ANTHROPIC_API_KEY`) | One shared key for all users. Budget it. |
| GitHub OAuth app | Sign-in with GitHub | Callback URL: `${APP_URL}/api/auth/github/callback` |
| GitHub token | Repo mode: read, branch, commit, open PR | Fine-grained token, scoped to the repos you allow |
| Resend | Magic-link email | Needs a verified sender domain for `RESEND_FROM` |
| Upstash Redis | Run state and locks | REST URL and token |
| Vercel | Hosting, cron | Hobby works; Pro recommended |

Creating any of these, and any key or env var, is a manual step for the owner.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in values; never commit .env.local
npm run dev                  # http://localhost:3000
```

Other scripts:

- `npm run typecheck`: `tsc --noEmit`
- `npm test`: unit tests via `tsx --test`, with a mocked Claude client (no real API calls)
- `npm run build`: production build
- `npm start`: serve the production build

Deploy previews are fine. Production deploys need your approval.

## Environment variables

See `.env.example` for the full list with comments. Summary:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Model calls |
| `ORCHESTRATOR_MODEL` / `LEAD_MODEL` / `WORKER_MODEL` | no | Defaults: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` |
| `ALLOWED_USERS` | yes | Comma-separated emails and/or GitHub logins. Empty denies everyone. |
| `SESSION_SECRET` | yes | HMAC key for the session cookie |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | for GitHub sign-in | OAuth app |
| `GITHUB_TOKEN` | for repo mode | Repo access and PRs |
| `RESEND_API_KEY` / `RESEND_FROM` | for magic links | Sending login emails |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | yes in production | Run state |
| `CRON_SECRET` | yes | Bearer secret for `/api/cron/kick` and the step endpoint. Only this exact value passes. |
| `APP_URL` | yes | Public base URL for callbacks, links, and self-calls |
| `TICKER_SYMBOLS` | no | Comma-separated tickers for the ticker bar, e.g. `AAPL,MSFT,NVDA`. Empty hides it. |

Generate secrets with:

```bash
openssl rand -base64 32   # SESSION_SECRET
openssl rand -hex 32      # CRON_SECRET
```

Never put secrets in code, in git, or in client-side variables.

## API

All routes require a signed session, except `/api/auth/*`. The step route and cron route accept only `Authorization: Bearer $CRON_SECRET`.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/runs` | List your runs / create a run (`{task, repo?}`) |
| GET | `/api/runs/:id` | Full run: agents, approvals, log, tokens, deadline, PR, final report |
| POST | `/api/runs/:id/kick` | Re-kick a run from the UI |
| POST | `/api/runs/:id/approvals/:approvalId` | `{decision: "approve" \| "deny"}` |
| POST | `/api/runs/:id/merge` | `{confirm: true}`. Owner only. Merges the PR. |
| POST | `/api/runs/:id/step` | Advance one step. `CRON_SECRET` only. |
| GET | `/api/cron/kick` | Cron: re-kick stalled runs. `CRON_SECRET` only. |

Users can only read their own runs.

## Gestures and camera mode

Optional hands-free control. Turn on camera mode from the dashboard and a small hand-tracking panel appears. Hand gestures map to dashboard actions: next or previous view, refresh, toggle sidebar, open detail, and fullscreen.

**Privacy:**

- Hand tracking runs **in your browser** using MediaPipe (`@mediapipe/tasks-vision`). Camera frames are processed locally and are **not uploaded** to the server.
- The camera is only started after you turn camera mode on, and it stops when you turn it off or leave the page.
- Camera access requires your browser's permission. The app sets `Permissions-Policy: camera=(self)`, so only this site can request it.
- MediaPipe loads its WASM and model assets on first use. Those requests go to the asset host, not your camera data. Self-host the assets if that matters to you.

## Repo layout

- `app/`: pages, layout, and API routes
- `components/`: UI, including the gesture layer
- `lib/`: `types.ts` (shared contract), auth, store, Claude and GitHub clients, prompts, engine
- `vercel.json`: cron schedule and function durations
