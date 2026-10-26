import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SYMBOLS, parseYahooChart, yahooUrl, parseSymbols } from "../app/api/ticker/parse";

test("parseSymbols falls back to defaults when unset or empty", () => {
  assert.deepEqual(parseSymbols(undefined), DEFAULT_SYMBOLS);
  assert.deepEqual(parseSymbols(""), DEFAULT_SYMBOLS);
  assert.deepEqual(parseSymbols(" , ,, "), DEFAULT_SYMBOLS);
  assert.deepEqual(parseSymbols("!!!;;"), DEFAULT_SYMBOLS);
});

test("parseSymbols splits on commas and whitespace, uppercases, dedupes", () => {
  assert.deepEqual(parseSymbols("aapl, msft  nvda\naapl"), ["AAPL", "MSFT", "NVDA"]);
});

test("parseSymbols drops unsafe characters and keeps index/dotted symbols", () => {
  assert.deepEqual(parseSymbols("spy,^spx,brk.b,a/b,<script>"), ["SPY", "^SPX", "BRK.B"]);
});

test("yahooUrl targets the chart endpoint on the chosen host and encodes the symbol", () => {
  const u1 = new URL(yahooUrl("SPY"));
  assert.equal(u1.origin + u1.pathname, "https://query1.finance.yahoo.com/v8/finance/chart/SPY");
  assert.equal(u1.searchParams.get("range"), "1d");
  assert.equal(u1.searchParams.get("interval"), "1d");
  assert.equal(new URL(yahooUrl("SPY", "query2")).hostname, "query2.finance.yahoo.com");
  assert.equal(new URL(yahooUrl("^SPX")).pathname, "/v8/finance/chart/%5ESPX");
});

const yahooBody = (meta: Record<string, unknown>) => ({
  chart: { result: [{ meta: { symbol: "SPY", currency: "USD", ...meta } }], error: null },
});

test("parseYahooChart reads regularMarketPrice and chartPreviousClose from meta", () => {
  const q = parseYahooChart(yahooBody({ regularMarketPrice: 759.97, chartPreviousClose: 763.96 }), "SPY");
  assert.equal(q?.symbol, "SPY");
  assert.equal(q?.price, 759.97);
  assert.ok(Math.abs((q?.change ?? 0) - -3.99) < 1e-9);
  assert.ok(Math.abs((q?.changePct ?? 0) - (-3.99 / 763.96) * 100) < 1e-9);
});

test("parseYahooChart reports under the requested symbol, not the body's", () => {
  const q = parseYahooChart(yahooBody({ regularMarketPrice: 10, chartPreviousClose: 8 }), "^SPX");
  assert.equal(q?.symbol, "^SPX");
  assert.equal(q?.change, 2);
  assert.equal(q?.changePct, 25);
});

test("parseYahooChart leaves change null when chartPreviousClose is missing or zero", () => {
  assert.deepEqual(parseYahooChart(yahooBody({ regularMarketPrice: 5 }), "X"), {
    symbol: "X",
    price: 5,
    change: null,
    changePct: null,
  });
  assert.deepEqual(parseYahooChart(yahooBody({ regularMarketPrice: 5, chartPreviousClose: 0 }), "X"), {
    symbol: "X",
    price: 5,
    change: 5,
    changePct: null,
  });
});

test("parseYahooChart returns null for an unknown symbol's error body", () => {
  const notFound = {
    chart: { result: null, error: { code: "Not Found", description: "No data found" } },
  };
  assert.equal(parseYahooChart(notFound, "NOSUCHX99"), null);
});

test("parseYahooChart returns null for missing, non-numeric, or non-positive prices", () => {
  assert.equal(parseYahooChart(yahooBody({ chartPreviousClose: 5 }), "X"), null);
  assert.equal(parseYahooChart(yahooBody({ regularMarketPrice: "759.97" }), "X"), null);
  assert.equal(parseYahooChart(yahooBody({ regularMarketPrice: 0 }), "X"), null);
  assert.equal(parseYahooChart(yahooBody({ regularMarketPrice: null }), "X"), null);
});

test("parseYahooChart returns null for any unexpected shape without throwing", () => {
  for (const body of [null, undefined, "x", 42, [], {}, { chart: null }, { chart: { result: [] } }, { chart: { result: [null] } }, { chart: { result: [{}] } }]) {
    assert.equal(parseYahooChart(body, "X"), null);
  }
});
