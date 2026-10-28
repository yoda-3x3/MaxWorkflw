import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chatErrorMessage, getChat, sendChat } from "./chatApi";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

test("getChat GETs /api/chat and returns the body", async () => {
  const body = { messages: [], pending: [], runner: { online: true } };
  const calls = stubFetch(200, body);
  assert.deepEqual(await getChat(), body);
  assert.equal(calls[0].url, "/api/chat");
  assert.equal(calls[0].init?.method, undefined);
});

test("sendChat POSTs the text as JSON and returns placement", async () => {
  const res = {
    message: { id: "m1", role: "user", text: "hi", createdAt: 1 },
    placement: "cloud",
    cloudError: "no runner",
  };
  const calls = stubFetch(201, res);
  assert.deepEqual(await sendChat("hi"), res);
  assert.equal(calls[0].url, "/api/chat");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { text: "hi" });
});

test("non-2xx responses throw the server's error message", async () => {
  stubFetch(400, { error: "text is empty" });
  await assert.rejects(sendChat(""), { message: "text is empty" });
});

test("non-2xx without an error body falls back to the status", async () => {
  globalThis.fetch = (async () => new Response("oops", { status: 500 })) as typeof fetch;
  await assert.rejects(getChat(), { message: "Request failed (500)" });
});

test("chatErrorMessage handles Error and non-Error values", () => {
  assert.equal(chatErrorMessage(new Error("boom")), "boom");
  assert.equal(chatErrorMessage("plain"), "plain");
});
