import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../app/api/ticker/route";

// The route caches for 60s and keys the cache on the symbol list, so each test uses its own
// TICKER_SYMBOLS value to force a fresh upstream refresh.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TICKER_SYMBOLS;
});

const yahoo = (price: number, prev: number) =>
  new Response(
    JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev } }], error: null } }),
    { status: 200 },
  );

function fetchBySymbol(table: Record<string, () => Response | Promise<Response>>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    for (const [sym, make] of Object.entries(table)) {
      if (url.includes(`/chart/${encodeURIComponent(sym)}?`)) return make();
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

test("GET returns quotes for the configured symbols in order, not stale", async () => {
  process.env.TICKER_SYMBOLS = "RT1,RT2";
  fetchBySymbol({ RT1: () => yahoo(10, 8), RT2: () => yahoo(20, 25) });

  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stale, false);
  assert.equal(body.quotes.length, 2);
  assert.deepEqual(body.quotes.map((q: { symbol: string }) => q.symbol), ["RT1", "RT2"]);
  assert.equal(body.quotes[0].change, 2);
  assert.equal(body.quotes[1].change, -5);
  assert.equal(typeof body.updatedAt, "number");
  assert.match(res.headers.get("Cache-Control") ?? "", /s-maxage=60/);
});

test("GET keeps the last good quote and marks stale when a later refresh fails", async () => {
  process.env.TICKER_SYMBOLS = "LG1,LG2";
  fetchBySymbol({ LG1: () => yahoo(1, 1), LG2: () => yahoo(2, 2) });
  await GET();

  // Force a new refresh by changing the key, with LG2 now failing everywhere.
  process.env.TICKER_SYMBOLS = "LG1,LG2,LG3";
  fetchBySymbol({ LG1: () => yahoo(5, 4), LG2: () => new Response("", { status: 500 }) });
  const body = await (await GET()).json();

  assert.equal(body.stale, true);
  const bySymbol = Object.fromEntries(body.quotes.map((q: { symbol: string; price: number }) => [q.symbol, q.price]));
  assert.equal(bySymbol.LG1, 5);
  assert.equal(bySymbol.LG2, 2, "last good quote for LG2 is kept");
  assert.equal(bySymbol.LG3, undefined, "never-fetched symbol is omitted");
});

test("GET returns an empty, stale list when every source fails and nothing was cached", async () => {
  process.env.TICKER_SYMBOLS = "EF1";
  globalThis.fetch = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;

  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.quotes, []);
  assert.equal(body.stale, true);
});

test("GET never throws, even when the fetch implementation throws synchronously", async () => {
  process.env.TICKER_SYMBOLS = "SY1";
  globalThis.fetch = (() => {
    throw new Error("sync");
  }) as unknown as typeof fetch;

  const res = await GET();
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).quotes, []);
});
