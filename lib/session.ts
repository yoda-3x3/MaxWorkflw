// Request-level helpers shared by the run routes: who is calling and how to answer.
// Web Crypto only, no node:* imports, so it runs on Workers.
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
 * allowed (ALLOWED_USERS). `verifySession` returns `id`, which is the owner key on Run.ownerId.
 */
export async function getCaller(req: Request): Promise<SessionUser | null> {
  return verifySession(readCookie(req, SESSION_COOKIE), process.env);
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
