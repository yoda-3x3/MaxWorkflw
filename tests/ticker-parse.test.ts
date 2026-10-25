import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SYMBOLS,
  parseStooqCsv,
  parseYahooChart,
  yahooUrl,
  parseSymbols,
  stooqSymbol,
  stooqUrl,
} from "../app/api/ticker/parse";

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

test("stooqSymbol adds .us to bare tickers and keeps explicit suffixes", () => {
  assert.equal(stooqSymbol("AAPL"), "aapl.us");
  assert.equal(stooqSymbol("VOD.UK"), "vod.uk");
});

test("stooqUrl is keyless CSV with a safely encoded symbol", () => {
  const url = new URL(stooqUrl("SPY"));
  assert.equal(url.origin + url.pathname, "https://stooq.com/q/l/");
  assert.equal(url.searchParams.get("s"), "spy.us");
  assert.equal(url.searchParams.get("e"), "csv");
});

test("parseStooqCsv reads close and computes change from previous close", () => {
  const csv = [
    "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev",
    "AAPL.US,2026-10-23,22:00:10,250.00,256.00,249.00,255.00,40000000,250.00",
  ].join("\n");
  const [q] = parseStooqCsv(csv);
  assert.deepEqual(q, { symbol: "AAPL", price: 255, change: 5, changePct: 2 });
});

test("parseStooqCsv handles a negative move and CRLF line endings", () => {
  const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume,Prev\r\nTSLA.US,2026-10-23,22:00:10,1,1,1,190,1,200\r\n";
  const [q] = parseStooqCsv(csv);
  assert.equal(q.symbol, "TSLA");
  assert.equal(q.price, 190);
  assert.equal(q.change, -10);
  assert.equal(q.changePct, -5);
});

test("parseStooqCsv tolerates reordered columns", () => {
  const csv = "Prev,Close,Symbol\n100,110,QQQ.US";
  const [q] = parseStooqCsv(csv);
  assert.deepEqual(q, { symbol: "QQQ", price: 110, change: 10, changePct: 10 });
});

test("parseStooqCsv returns null change when there is no previous close", () => {
  const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nMSFT.US,2026-10-23,22:00:10,1,1,1,400,1";
  const [q] = parseStooqCsv(csv);
  assert.deepEqual(q, { symbol: "MSFT", price: 400, change: null, changePct: null });
});

test("parseStooqCsv treats N/D and zero previous close as unknown change", () => {
  const nd = "Symbol,Close,Prev\nGOOGL.US,N/D,100";
  assert.deepEqual(parseStooqCsv(nd), []);

  const zeroPrev = "Symbol,Close,Prev\nGOOGL.US,5,0";
  assert.deepEqual(parseStooqCsv(zeroPrev), [{ symbol: "GOOGL", price: 5, change: 5, changePct: null }]);
});

test("parseStooqCsv returns [] for empty, header-only, or unrecognised input", () => {
  assert.deepEqual(parseStooqCsv(""), []);
  assert.deepEqual(parseStooqCsv("Symbol,Date,Close"), []);
  assert.deepEqual(parseStooqCsv("<html>rate limited</html>"), []);
  assert.deepEqual(parseStooqCsv("Foo,Bar\n1,2"), []);
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
