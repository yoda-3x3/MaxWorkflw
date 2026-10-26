import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { KICK_PATH, kickRequest, runScheduledKick } from "./cron";

describe("kickRequest", () => {
  test("GET to /api/cron/kick on APP_URL with the Bearer CRON_SECRET", () => {
    const req = kickRequest({ CRON_SECRET: "s3cret", APP_URL: "https://workflwpro.example.workers.dev" });
    assert.equal(req.method, "GET");
    assert.equal(req.url, `https://workflwpro.example.workers.dev${KICK_PATH}`);
    assert.equal(req.headers.get("authorization"), "Bearer s3cret");
  });

  test("falls back to localhost when APP_URL is unset", () => {
    const req = kickRequest({ CRON_SECRET: "s3cret" });
    assert.equal(new URL(req.url).pathname, KICK_PATH);
  });
});

describe("runScheduledKick", () => {
  test("sends the kick once and returns the response", async () => {
    const seen: Request[] = [];
    const res = await runScheduledKick({ CRON_SECRET: "s3cret", APP_URL: "https://app.test" }, async (req) => {
      seen.push(req);
      return new Response("{}", { status: 200 });
    });
    assert.equal(res?.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.get("authorization"), "Bearer s3cret");
  });

  test("passes through a non-2xx status without throwing", async () => {
    const res = await runScheduledKick({ CRON_SECRET: "s3cret" }, async () => new Response("no", { status: 500 }));
    assert.equal(res?.status, 500);
  });

  test("skips and never calls the app when CRON_SECRET is unset or empty", async () => {
    let calls = 0;
    const send = async () => {
      calls++;
      return new Response("{}");
    };
    assert.equal(await runScheduledKick({}, send), null);
    assert.equal(await runScheduledKick({ CRON_SECRET: "" }, send), null);
    assert.equal(calls, 0);
  });
});
