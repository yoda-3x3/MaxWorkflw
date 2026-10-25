# Build Prompt: MaxWorkflw Site

**How to use:** Give your Orchestrator the system prompt in `ORCHESTRATOR_PROMPT.md`. Send everything below the line as the first user message. It is written to be a complete task: the Orchestrator should follow its own workflow (clarify, explore, plan, dispatch, integrate, verify, report) and respect its hard limits and hard stops.

---

## TASK

Build **MaxWorkflw**, a web app that lets me run a 3-tier agent team from any browser (phone or locked-down school computer), the way my current "wdash" dashboard runs Claude, but more effective. The app itself implements the Orchestrator → Lead → Worker process from `ORCHESTRATOR_PROMPT.md`. Repo: `yoda-3x3/MaxWorkflw` (currently empty). Work on a branch. Target platform: **Vercel** (Next.js 15, App Router, TypeScript). Kickoff budget proposal: 14 agents max at once, 24h deadline, no paid service beyond what is listed below. State this budget and wait for my approval before spending.

### Definition of done

I can sign in, type a task (optionally naming a GitHub repo), and watch a wall of agents work. The run keeps going in the cloud after I close the tab. Repo work lands on a branch and a PR, and I press merge myself. Anything risky pauses for my approval in the dashboard.

### Decisions already made (do not re-ask)

1. **Engine:** direct Anthropic Messages API via `fetch` (no SDK needed). Key in `ANTHROPIC_API_KEY`. Models via env, defaults: Orchestrator `claude-opus-5-5`, Leads `claude-sonnet-5-5`, Workers `claude-haiku-5-5`. When there are no leads, workers use the lead model.
2. **Users:** me plus a few friends. Allowlist in `ALLOWED_USERS` (emails and/or GitHub logins; empty list denies everyone). One shared API key. Run history is per user and a user can only ever read their own runs.
3. **Auth:** GitHub OAuth **and** emailed magic link (Resend). Stateless HMAC-signed cookie (`SESSION_SECRET`), Web Crypto only so it works in middleware. Magic-link endpoint must not reveal whether an email is allowed. OAuth `state` is verified. Middleware protects every page and API except login and `/api/auth/*`.
4. **Cloud running:** closing the tab must not stop a run. Design for short serverless steps, never one long request:
   - Run state persisted in **Upstash Redis via REST** (in-memory fallback for local dev only).
   - A `step` endpoint does exactly one unit of work: plan, or one wave of ready agents (run in parallel), or finalize. When a step finishes with more to do it triggers the next step server-side (`after()` plus a fire-and-forget self-call authenticated with `CRON_SECRET`). Do not await the chained call, or invocations nest.
   - A per-run lock (`SET NX EX`) stops two steps driving one run. Agents stuck in `running` past a timeout are reset to `queued`. Each agent gets one retry, then is marked failed (the run continues and reports it).
   - Backup drivers: opening a run in the UI re-kicks it, and a Vercel cron route (`CRON_SECRET` bearer) re-kicks stalled runs.
5. **3-tier structure, enforced in code, not just in the prompt:** max 15 agents including the Orchestrator, max depth 3 tiers, 24h deadline per run (fail with a clear message if exceeded), exclusive scopes. The Orchestrator (Opus) first plans via JSON: `{summary, units:[{id,title,brief,deps,workers?}]}`. A unit with `workers` becomes a Lead (Sonnet) with Haiku workers; a unit without becomes a standalone Sonnet worker. Leads run only after their workers finish and **integrate** the worker reports. After all units finish the Orchestrator writes a self-contained final report. Plans over the cap are truncated and the cut is logged. Agents get the brief template and report format from `ORCHESTRATOR_PROMPT.md` §4, and reports are clipped when passed upward (summaries, not logs).
6. **Repo mode (optional per run):** user gives `owner/name`. Agents get tools `list_files`, `read_file`, `write_file`. Writes go **only** to branch `maxworkflw/<runId>` (created on demand from the default branch, retry on 409/422 concurrent commits). Block path traversal, `.git/`, and `.env*`. At the end open a PR. Token in `GITHUB_TOKEN`. **Never** merge, delete, or force-push automatically.
7. **Approvals (hard stops):** agents have a `request_approval` tool for the four hard stops in the Orchestrator prompt (production deploy; delete/force-push/migration; new paid service or secrets; exceeding budget). Ordinary work, including code that might break, does **not** ask: they proceed. When an agent requests approval, only that agent pauses. The rest keep going. When nothing else can run, the run shows "waiting for approval". Approve/Deny cards appear in the dashboard, and the decision is fed back into that agent's brief and it resumes. Decisions go through a **separate queue** that the step engine drains, so the UI can never overwrite a running step's saved state. Merge PR is a confirm-guarded button that only the signed-in owner can press.
8. **UI ("wall of agents"):** dark, mobile-friendly. Left: new-run form (task, optional repo) and run history. Main: run header (status, plan summary, agent count `n/15`, tokens, deadline, PR link + merge button), approval cards, final report, and **three switchable views, choice remembered**: (a) **Wall**, a live grid of cards per agent with tier badge, role, model, status, running timer and report snippet, with running ones visibly glowing; (b) **Tree**, Orchestrator → Leads → Workers; (c) **Timeline**, bars of when each agent ran. Clicking any agent opens its full brief and report. Include an activity log. Show "runs in the cloud: safe to close this tab" on active runs. Poll about every 3s.

### Suggested work units (the Orchestrator may re-slice; scopes must stay exclusive)

| Unit | Scope | Notes |
|---|---|---|
| Scaffold | `package.json`, `tsconfig.json`, `next.config.mjs`, `vercel.json`, `.env.example`, `.gitignore`, README | Must land first. Only deps: next, react, react-dom, typescript, @types. No new deps without asking. |
| Auth | `lib/auth.ts`, `middleware.ts`, `app/api/auth/**`, `app/login/**` | |
| Storage | `lib/store.ts`, `lib/types.ts` | Run, Agent, Approval types; get/save/index/list runs, lock, decision queue |
| LLM + GitHub clients | `lib/claude.ts`, `lib/github.ts` | Retry 429/5xx with backoff; request timeouts |
| Prompts | `lib/prompts.ts` | Condense `ORCHESTRATOR_PROMPT.md` into planner, agent, lead, and final prompts |
| Engine | `lib/engine.ts`, `app/api/runs/**`, `app/api/cron/**`, `lib/session.ts` | Depends on the four above. The hardest unit; give it a Sonnet lead or do it yourself |
| UI | `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `components/**` | Can start from the types contract |
| QA / review | read-only | Independent Sonnet reviewer on the final diff per §5 |

Define `lib/types.ts` first and hand it to every unit as the shared contract, so parallel work lines up.

### Constraints and acceptance checks

- Stateless handlers only: no local filesystem persistence, no long-lived processes. `maxDuration` set on the step route.
- No secrets in code or git. Everything via env vars documented in `.env.example`.
- `npm install`, `npx tsc --noEmit` and `next build` must pass. Add a few cheap tests for the pure logic (plan validation and cap enforcement, token sign/verify and allowlist, path blocking, ready-agent selection). Use a mocked Claude client, never real API calls in tests.
- Exercise one full run end to end with a **mocked** Claude client: plan → parallel wave → lead integration → final, plus one approval pause/resume and one agent failure/retry.
- Reviewer must specifically check: cross-user access to runs, auth bypass via the `Authorization` header on the step route (only the exact `CRON_SECRET` may pass), lost-update races between the UI and the engine, nested chaining invocations, and anything that could delete, force-push, or merge without my click.

### Known limits to state in the README

- Agents can't execute code (no sandbox), so "verified" means reviewed, not run. Say so in reports rather than faking test results.
- Vercel Hobby has short function limits and daily-only cron; Pro is recommended for long runs.

### Hard stops specific to this build (ask me first)

Creating the Upstash database, GitHub OAuth app, Resend account/domain, or any API keys or Vercel env vars; any production deploy (previews are fine); adding any dependency beyond the list above; exceeding the approved budget.

### Report back with

What was built and verified (with commands and results), what was cut, the exact env vars and external accounts I must create, and a step-by-step list of the approvals you need from me.
