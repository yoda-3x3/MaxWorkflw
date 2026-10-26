// Scheduled (cron) kick for Cloudflare Workers. The Vercel cron hits GET /api/cron/kick with
// Bearer CRON_SECRET; this does the same on each Cloudflare cron tick, through the OpenNext worker
// in-process so the request never leaves Cloudflare.

export const KICK_PATH = "/api/cron/kick";

export interface CronEnv {
  CRON_SECRET?: string;
  /** Public base URL, e.g. https://workflwpro.<account>.workers.dev. Only used to build the URL. */
  APP_URL?: string;
}

/** The request the cron sends to the app. Pure: no I/O. */
export function kickRequest(env: CronEnv): Request {
  return new Request(new URL(KICK_PATH, env.APP_URL || "http://localhost").toString(), {
    method: "GET",
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
  });
}

/**
 * Sends the kick through `send` (the OpenNext worker's fetch, bound to env and ctx). Without
 * CRON_SECRET it skips, the same way the route denies every call. Returns the response, or null
 * when it skipped.
 */
export async function runScheduledKick(
  env: CronEnv,
  send: (req: Request) => Promise<Response>,
): Promise<Response | null> {
  if (!env.CRON_SECRET) {
    console.error("cron: CRON_SECRET is not set, skipping kick");
    return null;
  }
  const res = await send(kickRequest(env));
  if (res.ok) {
    console.log(`cron: kick ok (${res.status})`);
  } else {
    console.error(`cron: kick failed (${res.status})`);
  }
  return res;
}
