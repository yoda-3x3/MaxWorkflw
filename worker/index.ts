// Worker entry for Cloudflare (wrangler.jsonc "main"). Wraps the OpenNext worker, which only
// exists after `npm run cf:build`, so this file is excluded from `tsc` (see tsconfig.json).
import openNext from "../.open-next/worker.js";
import { runScheduledKick, type CronEnv } from "./cron";

// Keep the named exports (e.g. Durable Object classes) that the OpenNext worker exposes.
export * from "../.open-next/worker.js";

export default {
  fetch: openNext.fetch,

  scheduled(_controller: ScheduledController, env: CronEnv, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledKick(env, (req) => openNext.fetch(req, env, ctx)));
  },
} satisfies ExportedHandler<CronEnv>;
