import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isCronAuthorized, readCookie } from "@/lib/session";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { POST as stepPost } from "@/app/api/runs/[id]/step/route";

const SECRET = "test-cron-secret-value";

function req(headers: Record<string, string> = {}, url = "https://app.test/api/runs/r1/step") {
  return new Request(url, { method: "POST", headers });
}

describe("isCronAuthorized", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  test("accepts the exact bearer", () => {
    assert.equal(isCronAuthorized(req({ authorization: `Bearer ${SECRET}` })), true);
  });

  test("rejects a missing header", () => {
    assert.equal(isCronAuthorized(req()), false);
  });

  test("rejects a wrong secret of the same length", () => {
    const wrong = "x".repeat(SECRET.length);
    assert.equal(isCronAuthorized(req({ authorization: `Bearer ${wrong}` })), false);
  });

  test("rejects a secret that is a prefix or extension of the real one", () => {
    assert.equal(isCronAuthorized(req({ authorization: `Bearer ${SECRET.slice(0, -1)}` })), false);
    assert.equal(isCronAuthorized(req({ authorization: `Bearer ${SECRET}x` })), false);
  });

  test("rejects other schemes and bare secrets", () => {
    assert.equal(isCronAuthorized(req({ authorization: SECRET })), false);
    assert.equal(isCronAuthorized(req({ authorization: `Basic ${SECRET}` })), false);
  });

  test("denies everything when CRON_SECRET is unset or empty", () => {
    delete process.env.CRON_SECRET;
    assert.equal(isCronAuthorized(req({ authorization: "Bearer " })), false);
    process.env.CRON_SECRET = "";
    assert.equal(isCronAuthorized(req({ authorization: "Bearer " })), false);
  });
});

describe("step route auth", () => {
  let saved: Record<string, string | undefined>;
  const params = () => Promise.resolve({ id: "no-such-run" });

  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, SESSION_SECRET: process.env.SESSION_SECRET };
    process.env.CRON_SECRET = SECRET;
    process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("a user session cookie alone gets 401", async () => {
    const token = await createSession({ method: "magic_link", email: "alice@example.com" }, process.env.SESSION_SECRET);
    const res = await stepPost(req({ cookie: `${SESSION_COOKIE}=${token}` }), { params: params() });
    assert.equal(res.status, 401);
  });

  test("no Authorization header gets 401", async () => {
    const res = await stepPost(req(), { params: params() });
    assert.equal(res.status, 401);
  });

  test("a wrong secret gets 401", async () => {
    const res = await stepPost(req({ authorization: `Bearer ${"x".repeat(SECRET.length)}` }), { params: params() });
    assert.equal(res.status, 401);
  });

  test("bearer-prefix variants get 401: lowercase scheme, double space, missing secret, bare secret", async () => {
    for (const authorization of [`bearer ${SECRET}`, `Bearer  ${SECRET}`, "Bearer", "Bearer ", SECRET]) {
      const res = await stepPost(req({ authorization }), { params: params() });
      assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(authorization)}`);
    }
  });

  test("the exact CRON_SECRET bearer gets 202 right away", async () => {
    const res = await stepPost(req({ authorization: `Bearer ${SECRET}` }), { params: params() });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: true });
  });
});

describe("readCookie", () => {
  test("finds a named cookie among several", () => {
    const r = req({ cookie: "a=1; mw_session=abc.def; b=2" });
    assert.equal(readCookie(r, "mw_session"), "abc.def");
  });

  test("returns undefined when absent and decodes values", () => {
    assert.equal(readCookie(req({ cookie: "a=1" }), "mw_session"), undefined);
    assert.equal(readCookie(req({ cookie: "mw_session=a%2Bb" }), "mw_session"), "a+b");
  });
});
