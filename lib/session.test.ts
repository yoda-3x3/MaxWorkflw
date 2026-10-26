import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { getCaller, readCookie } from "@/lib/session";

const SECRET = "session-test-secret-".padEnd(40, "x");
// getCaller checks expiry against the real clock, so tokens are issued now.
const NOW = Math.floor(Date.now() / 1000);

const savedEnv = { SESSION_SECRET: process.env.SESSION_SECRET, ALLOWED_USERS: process.env.ALLOWED_USERS };

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.ALLOWED_USERS = "bob-gh";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("readCookie", () => {
  test("reads a named cookie and ignores others", () => {
    const req = new Request("https://x.test/", { headers: { cookie: "a=1; mw_session=abc%2Edef; b=2" } });
    assert.equal(readCookie(req, "mw_session"), "abc.def");
    assert.equal(readCookie(req, "missing"), undefined);
  });

  test("returns undefined without a cookie header", () => {
    assert.equal(readCookie(new Request("https://x.test/"), SESSION_COOKIE), undefined);
  });
});

describe("getCaller", () => {
  test("returns the owner for a valid session of an allowed user", async () => {
    const token = await createSession({ method: "github", login: "bob-gh" }, SECRET, NOW);
    const req = new Request("https://x.test/", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    const caller = await getCaller(req);
    assert.equal(caller?.id, "github:bob-gh");
  });

  test("returns null with no cookie", async () => {
    assert.equal(await getCaller(new Request("https://x.test/")), null);
  });

  test("returns null once the user is no longer in ALLOWED_USERS", async () => {
    const token = await createSession({ method: "github", login: "bob-gh" }, SECRET, NOW);
    process.env.ALLOWED_USERS = "carol-gh";
    const req = new Request("https://x.test/", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    assert.equal(await getCaller(req), null);
  });
});
