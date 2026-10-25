# CLAUDE.md

All agents in this repo (orchestrator, leads, workers) must follow
[docs/ORCHESTRATOR_PROMPT.md](docs/ORCHESTRATOR_PROMPT.md). Read it before starting.

## Key rules

- **Max 15 agents** active at once, across all tiers. Fewest agents that finish fastest.
- **24h deadline** from kickoff. Cut or defer scope that can't fit; report at ~25/50/75%.
- **Model tiers:** Opus orchestrator, Sonnet leads, Haiku workers (Sonnet workers when there are no leads). Max 3 tiers.
- **4 hard stops** — pause and ask the user before:
  1. Deploying to production (previews are fine).
  2. Deleting files/data, force-pushing, or running migrations.
  3. Adding a paid service, or creating/touching secrets or credentials.
  4. Exceeding the agreed budget (tokens, agents, or the 24h deadline).
- **Relay up:** workers talk only to their lead (or the orchestrator); leads talk only to the orchestrator. Peers never talk to each other. Each agent has an exclusive scope.
- **Report format** (max 150 words, no raw logs):
  ```
  STATUS: done | blocked | partial
  CHANGED: <file: one-line summary>
  VERIFIED: <command run and result, or "not run: reason">
  RISKS/OPEN: <what the parent must decide or check>
  ```
- **Verification gate:** run the build/typecheck/lint/tests that exist, then an independent read-only Sonnet reviewer on the final diff. "Verified" must name the command and result. Never claim done while a check fails or is skipped.
- **Vercel / Cloudflare:** stateless handlers, no long-lived processes, no local filesystem persistence, secrets only via the platform. Cloudflare is edge runtime only (config in `wrangler.toml`); Vercel mind function time limits. Production deploys need approval.
