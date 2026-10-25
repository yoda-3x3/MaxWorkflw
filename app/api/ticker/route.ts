import { NextResponse } from "next/server";
import { parseStooqCsv, parseSymbols, stooqUrl, type Quote } from "./parse";

// Keyless quotes from Stooq, fetched server-side so the browser never talks to Stooq.
// Failures never produce an error response: the last good quote per symbol is
// returned, or an empty list, and the UI hides the bar.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 4_000;

// Module-level state persists across requests within a warm serverless instance.
let cachedAt = 0;
let cachedKey = "";
let stale = false;
const lastGood = new Map<string, Quote>();
let inflight: Promise<void> | null = null;

async function fetchQuote(symbol: string): Promise<Quote | null> {
  try {
    const res = await fetch(stooqUrl(symbol), {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "wdash-ticker/1.0" },
    });
    if (!res.ok) return null;
    const parsed = parseStooqCsv(await res.text())[0];
    // Report under the requested symbol so lookups never depend on Stooq's naming.
    return parsed ? { ...parsed, symbol } : null;
  } catch {
    return null;
  }
}

async function refresh(symbols: string[], key: string): Promise<void> {
  const results = await Promise.all(symbols.map(fetchQuote));
  let failures = 0;
  results.forEach((quote, i) => {
    if (quote) lastGood.set(symbols[i], quote);
    else failures++;
  });
  stale = failures > 0;
  cachedKey = key;
  // Stamp even on total failure so a Stooq outage is not retried on every request.
  cachedAt = Date.now();
}

export async function GET() {
  const symbols = parseSymbols(process.env.TICKER_SYMBOLS);
  const key = symbols.join(",");

  if (cachedKey !== key || Date.now() - cachedAt >= CACHE_MS) {
    inflight ??= refresh(symbols, key).finally(() => {
      inflight = null;
    });
    await inflight;
  }

  const quotes = symbols.flatMap((s) => {
    const q = lastGood.get(s);
    return q ? [q] : [];
  });

  return NextResponse.json(
    { quotes, stale, updatedAt: cachedAt },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" } },
  );
}
