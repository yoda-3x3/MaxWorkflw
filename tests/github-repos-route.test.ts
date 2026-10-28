import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { GET, POST } from "@/app/api/github/repos/route";

const SECRET = "route-test-secret-".padEnd(40, "x");
const SAVED_KEYS = ["SESSION_SECRET", "ALLOWED_USERS", "GITHUB_TOKEN"] as const;

let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(SAVED_KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  process.env.SESSION_SECRET = SECRET;
  process.env.ALLOWED_USERS = "alice";
  process.env.GITHUB_TOKEN = "route-test-token";
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of SAVED_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function cookieFor(login = "alice") {
  return `${SESSION_COOKIE}=${await createSession({ method: "github", login }, SECRET)}`;
}

const apiRepo = (fullName: string, priv = false) => {
  const [owner, name] = fullName.split("/");
  return { full_name: fullName, name, owner: { login: owner }, private: priv, default_branch: "main" };
};

function stubGitHub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return calls;
}

describe("GET /api/github/repos", () => {
  test("401 without a valid session, and no GitHub call", async () => {
    const calls = stubGitHub(() => new Response("[]"));
    const res = await GET(new Request("https://app.test/api/github/repos"));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  test("401 when the login is no longer on ALLOWED_USERS", async () => {
    const res = await GET(new Request("https://app.test/api/github/repos", { headers: { cookie: await cookieFor("mallory") } }));
    assert.equal(res.status, 401);
  });

  test("503 when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    const res = await GET(new Request("https://app.test/api/github/repos", { headers: { cookie: await cookieFor() } }));
    assert.equal(res.status, 503);
  });

  test("returns a filtered page and sends the token to GitHub only", async () => {
    const calls = stubGitHub(() =>
      new Response(JSON.stringify([apiRepo("acme/api"), apiRepo("acme/web", true), apiRepo("other/x")]), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await GET(new Request("https://app.test/api/github/repos?q=acme&perPage=1", { headers: { cookie: await cookieFor() } }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { repos: { fullName: string; private: boolean; defaultBranch: string }[]; total: number; hasMore: boolean; truncated: boolean };
    assert.deepEqual(body.repos.map((r) => r.fullName), ["acme/api"]);
    assert.equal(body.total, 2);
    assert.equal(body.hasMore, true);
    assert.equal(body.truncated, false);
    assert.equal(body.repos[0].defaultBranch, "main");
    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), "Bearer route-test-token");
    assert.ok(!JSON.stringify(body).includes("route-test-token"), "token must not reach the browser");
  });

  test("a GitHub failure becomes 502 with no token in the message", async () => {
    stubGitHub(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    const res = await GET(new Request("https://app.test/api/github/repos", { headers: { cookie: await cookieFor() } }));
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /401/);
    assert.ok(!body.error.includes("route-test-token"));
  });
});

describe("POST /api/github/repos", () => {
  const post = async (body: unknown, cookie?: string) =>
    POST(
      new Request("https://app.test/api/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  test("401 without a session and no GitHub call", async () => {
    const calls = stubGitHub(() => new Response("{}", { status: 201 }));
    assert.equal((await post({ name: "app" })).status, 401);
    assert.equal(calls.length, 0);
  });

  test("400 for a bad name, a non-JSON body, or a non-boolean private flag, with no GitHub call", async () => {
    const calls = stubGitHub(() => new Response("{}", { status: 201 }));
    const cookie = await cookieFor();
    assert.equal((await post({ name: "../escape" }, cookie)).status, 400);
    assert.equal((await post({}, cookie)).status, 400);
    assert.equal((await post("not json", cookie)).status, 400);
    assert.equal((await post({ name: "app", private: "yes" }, cookie)).status, 400);
    assert.equal(calls.length, 0);
  });

  test("creates a private repo by default and returns 201 with owner/name", async () => {
    let sent: any;
    stubGitHub((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(apiRepo("alice/new-app", true)), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    const res = await post({ name: "new-app" }, await cookieFor());
    assert.equal(res.status, 201);
    assert.equal(sent.private, true);
    assert.equal(sent.auto_init, true);
    const body = (await res.json()) as { fullName: string; private: boolean };
    assert.equal(body.fullName, "alice/new-app");
    assert.equal(body.private, true);
  });

  test("a name that already exists gets 409 with a clear message", async () => {
    stubGitHub(() =>
      new Response(JSON.stringify({ message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }), { status: 422 }),
    );
    const res = await post({ name: "app" }, await cookieFor());
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /already have a repo named app/);
  });
});
