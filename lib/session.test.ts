import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dispatchRun, runAfterResponse } from "@/lib/session";

function recordingFetch(response: () => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  return { fn, calls };
}

describe("dispatchRun", () => {
  test("is a no-op without GITHUB_TOKEN", async () => {
    const { fn, calls } = recordingFetch(async () => new Response(null, { status: 204 }));
    await dispatchRun("run-1", { env: {}, fetch: fn });
    assert.equal(calls.length, 0);
  });

  test("never throws when the dispatch request fails", async () => {
    const { fn } = recordingFetch(async () => {
      throw new Error("network down");
    });
    const saved = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(dispatchRun("run-2", { env: { GITHUB_TOKEN: "t" }, fetch: fn }));
    } finally {
      console.error = saved;
    }
  });

  test("never throws on a non-2xx dispatch response", async () => {
    const { fn } = recordingFetch(async () => new Response("nope", { status: 422 }));
    const saved = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(dispatchRun("run-3", { env: { GITHUB_TOKEN: "t" }, fetch: fn }));
    } finally {
      console.error = saved;
    }
  });

  test("sends a workflow dispatch carrying the run id when a token is set", async () => {
    const { fn, calls } = recordingFetch(async () => new Response(null, { status: 204 }));
    await dispatchRun("run-4", { env: { GITHUB_TOKEN: "t" }, fetch: fn });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].init?.body ?? ""), /run-4/);
  });
});

describe("runAfterResponse", () => {
  test("runs the task inline outside a request scope", async () => {
    let ran = false;
    runAfterResponse(async () => {
      ran = true;
    });
    // The task is started synchronously when after() throws, so it has begun by now.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ran, true);
  });
});
