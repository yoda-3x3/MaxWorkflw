import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the PC runner is online, from its heartbeat key. Any signed-in user on ALLOWED_USERS. */
export async function GET(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  return json(await getRunStore().getRunnerStatus());
}
