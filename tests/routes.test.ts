import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isCronAuthorized, readCookie } from "@/lib/session";

const SECRET = "test-cron-secret-value";

function req(headers: Record<string, string> = {}, url = "https://app.test/api/cron/kick") {
  return new Request(url, { method: "GET", headers });
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

  test("rejects bearer-prefix variants: lowercase scheme, double space, missing secret", () => {
    for (const authorization of [`bearer ${SECRET}`, `Bearer  ${SECRET}`, "Bearer", "Bearer "]) {
      assert.equal(isCronAuthorized(req({ authorization })), false, `expected reject for ${JSON.stringify(authorization)}`);
    }
  });

  test("denies everything when CRON_SECRET is unset or empty", () => {
    delete process.env.CRON_SECRET;
    assert.equal(isCronAuthorized(req({ authorization: "Bearer " })), false);
    process.env.CRON_SECRET = "";
    assert.equal(isCronAuthorized(req({ authorization: "Bearer " })), false);
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
