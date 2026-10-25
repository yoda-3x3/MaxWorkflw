import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchQuote, fetchQuotes } from "../app/api/ticker/quotes";

type Reply = { status?: number; body?: string } | "throw";

// Builds a fetch stub that answers by host. Each call is recorded so tests can check order.
function stubFetch(routes: Record<string, Reply>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const host = Object.keys(routes).find((h) => url.includes(h));
    const reply = host ? routes[host] : "throw";
    if (reply === "throw") throw new TypeError("network down");
    return new Response(reply.body ?? "", { status: reply.status ?? 200 });
  };
  return { impl, calls };
}

const yahoo = (price: number, prev: number) =>
  JSON.stringify({
    chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev } }], error: null },
  });

const notFound = JSON.stringify({
  chart: { result: null, error: { code: "Not Found", description: "No data found" } },
});

test("fetchQuote uses query1 Yahoo first and returns its quote", async () => {
  const { impl, calls } = stubFetch({ "query1.finance.yahoo.com": { body: yahoo(100, 90) } });
  const q = await fetchQuote("AAPL", impl);
  assert.deepEqual(q, { symbol: "AAPL", price: 100, change: 10, changePct: 10 / 90 * 100 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL\?/);
});

test("fetchQuote sends a browser-like User-Agent", async () => {
  const { impl, calls } = stubFetch({ "query1.finance.yahoo.com": { body: yahoo(1, 1) } });
  await fetchQuote("AAPL", impl);
  assert.match(calls[0].headers["User-Agent"], /^Mozilla\/5\.0/);
});

test("fetchQuote falls back to query2 when query1 errors or is rate-limited", async () => {
  const { impl, calls } = stubFetch({
    "query1.finance.yahoo.com": { status: 429, body: "Too Many Requests" },
    "query2.finance.yahoo.com": { body: yahoo(50, 40) },
  });
  const q = await fetchQuote("SPY", impl);
  assert.equal(q?.price, 50);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /query2\.finance\.yahoo\.com/);
});

test("fetchQuote falls back when query1 throws a network error", async () => {
  const { impl } = stubFetch({
    "query1.finance.yahoo.com": "throw",
    "query2.finance.yahoo.com": { body: yahoo(7, 6) },
  });
  assert.equal((await fetchQuote("QQQ", impl))?.price, 7);
});

test("fetchQuote falls back when query1 returns an unknown-symbol body", async () => {
  const { impl } = stubFetch({
    "query1.finance.yahoo.com": { body: notFound },
    "query2.finance.yahoo.com": { body: yahoo(3, 3) },
  });
  assert.equal((await fetchQuote("ZZZ", impl))?.price, 3);
});

test("fetchQuote falls back to Stooq CSV as the last source", async () => {
  const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev\nAAPL.US,2026-10-23,22:00:10,1,1,1,255,1,250";
  const { impl, calls } = stubFetch({
    "yahoo.com": { status: 500 },
    "stooq.com": { body: csv },
  });
  const q = await fetchQuote("AAPL", impl);
  assert.deepEqual(q, { symbol: "AAPL", price: 255, change: 5, changePct: 2 });
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /^https:\/\/stooq\.com\/q\/l\//);
});

test("fetchQuote returns null when every source fails, without throwing", async () => {
  const { impl, calls } = stubFetch({
    "yahoo.com": "throw",
    "stooq.com": { body: "<html>The page you requested does not exist</html>" },
  });
  assert.equal(await fetchQuote("NOPE", impl), null);
  assert.equal(calls.length, 3);
});

test("fetchQuotes runs every symbol and keeps null for failed ones", async () => {
  const { impl } = stubFetch({
    "query1.finance.yahoo.com": { body: yahoo(1, 1) },
    "query2.finance.yahoo.com": { body: yahoo(1, 1) },
    "stooq.com": { body: "" },
  });
  const results = await fetchQuotes(["A", "B"], impl);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.symbol, "A");
  assert.equal(results[1]?.symbol, "B");
});

test("fetchQuotes never rejects even if the fetch implementation throws synchronously", async () => {
  const boom = (() => {
    throw new Error("sync boom");
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchQuotes(["A"], boom), [null]);
});
