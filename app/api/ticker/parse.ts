// Pure helpers for the ticker: symbol parsing, source URL building, and response parsing.
// Kept free of Next/fetch imports so tests can run them directly.

export const DEFAULT_SYMBOLS = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  "TSLA",
  "META",
  "SPY",
  "QQQ",
];

export interface Quote {
  symbol: string;
  price: number;
  change: number | null;
  changePct: number | null;
}

// Letters, digits, dot, dash, caret (index symbols like ^SPX). Anything else is dropped.
const SYMBOL_RE = /^[A-Z0-9.\-^]{1,12}$/;

export function parseSymbols(raw: string | undefined | null): string[] {
  const list = (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => SYMBOL_RE.test(s));
  const unique = Array.from(new Set(list));
  return unique.length > 0 ? unique : DEFAULT_SYMBOLS;
}

// Builds a quote from a price and an optional previous close. Change is null when
// there is no usable previous close, and changePct is null when it is zero.
export function makeQuote(symbol: string, price: number, prev: number | null): Quote {
  const change = prev !== null ? price - prev : null;
  const changePct = prev !== null && prev !== 0 ? (change! / prev) * 100 : null;
  return { symbol, price, change, changePct };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Yahoo's chart endpoint. Only the daily range is needed; the price and previous close
// live in result[0].meta.
export function yahooUrl(symbol: string, host: "query1" | "query2" = "query1"): string {
  const path = encodeURIComponent(symbol);
  return `https://${host}.finance.yahoo.com/v8/finance/chart/${path}?range=1d&interval=1d`;
}

// Parses a decoded Yahoo chart body. Unknown symbols come back as { chart: { result: null,
// error } }, which yields null, as does any body whose shape is unexpected.
export function parseYahooChart(body: unknown, symbol: string): Quote | null {
  if (typeof body !== "object" || body === null) return null;
  const chart = (body as { chart?: unknown }).chart;
  if (typeof chart !== "object" || chart === null) return null;
  const result = (chart as { result?: unknown }).result;
  if (!Array.isArray(result) || typeof result[0] !== "object" || result[0] === null) return null;
  const meta = (result[0] as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return null;

  const price = finiteNumber((meta as { regularMarketPrice?: unknown }).regularMarketPrice);
  if (price === null || price <= 0) return null;
  const prev = finiteNumber((meta as { chartPreviousClose?: unknown }).chartPreviousClose);
  return makeQuote(symbol, price, prev);
}

