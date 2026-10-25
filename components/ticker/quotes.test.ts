import { test } from "node:test";
import assert from "node:assert/strict";
import { quotesFromResponse } from "./quotes";

test("an empty API result yields no quotes, so the ticker hides", () => {
  assert.deepEqual(quotesFromResponse({ quotes: [], stale: false, updatedAt: 0 }), []);
});

test("a body without a quotes array yields no quotes", () => {
  assert.deepEqual(quotesFromResponse({}), []);
  assert.deepEqual(quotesFromResponse({ quotes: "nope" }), []);
  assert.deepEqual(quotesFromResponse(null), []);
  assert.deepEqual(quotesFromResponse("text"), []);
});

test("quotes are passed through in order", () => {
  const quotes = [
    { symbol: "AAPL", price: 1, changePct: 0.5 },
    { symbol: "MSFT", price: 2, changePct: null },
  ];
  assert.deepEqual(quotesFromResponse({ quotes }), quotes);
});
