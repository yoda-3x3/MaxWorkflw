import { randomUUID } from "node:crypto";
import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pings the PC runner: puts a ping at the front of its queue and returns the nonce to poll with.
 * The idle runner reads its queue every 15 s, so an answer normally comes within that.
 */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  const nonce = randomUUID();
  await getRunStore().sendPing(nonce);
  return json({ nonce, sentAt: Date.now() }, 202);
}

/** The runner's answer to ping `nonce`, or `{ answered: false }` while there is none. */
export async function GET(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  const nonce = new URL(req.url).searchParams.get("nonce") ?? "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return json({ error: "bad nonce" }, 400);
  const pong = await getRunStore().getPong(nonce);
  return json(pong ? { answered: true, host: pong.host, at: pong.at } : { answered: false });
}
