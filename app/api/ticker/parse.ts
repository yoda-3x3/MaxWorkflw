// Pure helpers for the ticker: symbol parsing, Stooq URL building, CSV parsing.
// Kept free of Next/fetch imports so tests/ticker-parse.test.ts can run them directly.

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

// Stooq wants lowercase tickers with a market suffix. Bare US tickers get ".us".
export function stooqSymbol(symbol: string): string {
  const lower = symbol.toLowerCase();
  return lower.includes(".") ? lower : `${lower}.us`;
}

export function stooqUrl(symbol: string): string {
  const params = new URLSearchParams({
    s: stooqSymbol(symbol),
    f: "sd2t2ohlcvp", // symbol, date, time, open, high, low, close, volume, previous close
    h: "",
    e: "csv",
  });
  return `https://stooq.com/q/l/?${params.toString()}`;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "N/D") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Parses Stooq's CSV (header row + one row per symbol). Columns are located by
// name, so a reordered header still works. Rows with no usable close are skipped.
export function parseStooqCsv(csv: string): Quote[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iSymbol = col("symbol");
  const iClose = col("close");
  // Previous-close header name varies ("Prev", "Previous"...), so match by prefix.
  const iPrev = header.findIndex((h) => h.startsWith("prev"));
  if (iSymbol < 0 || iClose < 0) return [];

  const quotes: Quote[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const rawSymbol = cells[iSymbol]?.trim() ?? "";
    const symbol = rawSymbol.replace(/\.[A-Z]+$/i, "").toUpperCase();
    const price = toNumber(cells[iClose]);
    if (!symbol || price === null) continue;

    const prev = iPrev >= 0 ? toNumber(cells[iPrev]) : null;
    const change = prev !== null ? price - prev : null;
    const changePct = prev !== null && prev !== 0 ? (change! / prev) * 100 : null;
    quotes.push({ symbol, price, change, changePct });
  }
  return quotes;
}
