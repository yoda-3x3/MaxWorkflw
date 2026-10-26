import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readCookie } from "@/lib/session";

function req(headers: Record<string, string> = {}, url = "https://app.test/api/runs") {
  return new Request(url, { method: "GET", headers });
}

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
