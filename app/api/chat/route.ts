import { randomUUID } from "node:crypto";
import { dispatchCloudRunner } from "@/lib/cloud";
import { cleanChatText, pendingMessageIds } from "@/lib/chat";
import { getCaller, json } from "@/lib/session";
import { getRunStore } from "@/lib/store";
import { CHAT_MAX_CHARS, type ChatJob, type ChatMessage, type Placement } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The owner's chat: the general one, or the one for `?runId=`. Returns the messages, the ids still
 * waiting for a reply, and whether the PC runner is online (the page shows a notice when it is not).
 */
export async function GET(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);
  const store = getRunStore();
  const runId = new URL(req.url).searchParams.get("runId") ?? undefined;
  if (runId !== undefined) {
    if (!RUN_ID_RE.test(runId)) return json({ error: "invalid run id" }, 400);
    if (!(await store.getRun(caller.id, runId))) return json({ error: "not found" }, 404);
  }
  const [messages, runner] = await Promise.all([
    store.listChatMessages(caller.id, runId),
    store.getRunnerStatus(),
  ]);
  return json({ messages, pending: pendingMessageIds(messages), runner: { online: runner.online } });
}

/**
 * Sends the owner's message and queues it for the Orchestrator. The reply comes later, from the
 * runner, as an `orchestrator` message in the same chat. Goes to the PC when its runner is online,
 * otherwise to the cloud runner (the same rule as auto runs).
 */
export async function POST(req: Request) {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => null)) as { text?: unknown; runId?: unknown } | null;
  const text = cleanChatText(body?.text);
  if (!text) return json({ error: `message must be 1 to ${CHAT_MAX_CHARS} characters` }, 400);

  const store = getRunStore();
  let runId: string | undefined;
  if (body?.runId !== undefined && body.runId !== null && body.runId !== "") {
    if (typeof body.runId !== "string" || !RUN_ID_RE.test(body.runId)) return json({ error: "invalid run id" }, 400);
    if (!(await store.getRun(caller.id, body.runId))) return json({ error: "not found" }, 404);
    runId = body.runId;
  }

  const now = Date.now();
  const message: ChatMessage = { id: randomUUID(), role: "user", text, ...(runId ? { runId } : {}), createdAt: now };
  const job: ChatJob = { id: randomUUID(), ownerId: caller.id, ...(runId ? { runId } : {}), messageId: message.id, text, createdAt: now };

  const runner = await store.getRunnerStatus();
  const placement: Placement = runner.online ? "pc" : "cloud";
  await store.appendChatMessages(caller.id, runId, [message]);
  await store.enqueueChatJob(job, placement);

  if (placement === "pc") return json({ message, placement }, 201);
  const started = await dispatchCloudRunner();
  return json({ message, placement, ...(started.ok ? {} : { cloudError: started.error }) }, 201);
}
