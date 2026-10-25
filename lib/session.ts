// Request-level helpers shared by the run and cron routes: who is calling, whether a
// cron/step call is authorized, and how a run is kicked.
import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import type { SessionUser } from "@/lib/types";

/** Reads one cookie value from the request, or undefined. */
export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * The signed-in user, or null when there is no valid session cookie or the identity is no longer
 * allowed. `verifySession` returns `id`, which is the owner key on Run.ownerId.
 */
export async function getCaller(req: Request): Promise<SessionUser | null> {
  return verifySession(readCookie(req, SESSION_COOKIE), process.env);
}

/**
 * Only the exact `Authorization: Bearer ${CRON_SECRET}` passes. Unset or empty secret denies
 * everything. Compared in constant time.
 */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Calls the step route with CRON_SECRET and waits for its dispatch. The step route answers 202
 * before it does any work, so awaiting here does not nest invocations. Awaiting guarantees the
 * request is sent before this invocation can be frozen. Failures are logged, and the cron backstop
 * and UI kick recover a dropped step.
 */
export async function kickStep(origin: string, runId: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const url = `${origin}/api/runs/${encodeURIComponent(runId)}/step`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    if (!res.ok) console.error(`kickStep ${runId}: step responded ${res.status}`);
  } catch (err) {
    console.error(`kickStep ${runId}: dispatch failed`, err);
  }
}

/**
 * Runs `task` after the response is sent. Outside a Next request scope (unit tests), after()
 * throws, so the task runs inline and the caller does not wait for it.
 */
export function runAfterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/** Schedules kickStep for after the current response has been sent. */
export function scheduleKick(origin: string, runId: string): void {
  runAfterResponse(() => kickStep(origin, runId));
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
