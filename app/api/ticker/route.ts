import { NextResponse } from "next/server";
import { parseSymbols, type Quote } from "./parse";
import { fetchQuotes } from "./quotes";

// Keyless quotes from Yahoo Finance's chart endpoint, fetched server-side so the browser
// never talks to the upstream host. Failures never produce an error response: the last good
// quote per symbol is returned, or an empty list, and the UI hides the bar (quotes quietly
// unavailable). Edge caching is short: s-maxage=60 keeps upstream requests to ~1 batch/min.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 60_000;

// Module-level state persists across requests within a warm serverless instance.
let cachedAt = 0;
let cachedKey = "";
let stale = false;
const lastGood = new Map<string, Quote>();
let inflight: Promise<void> | null = null;

async function refresh(symbols: string[], key: string): Promise<void> {
  const results = await fetchQuotes(symbols);
  let failures = 0;
  results.forEach((quote, i) => {
    // A failed symbol keeps its previous quote, so one bad fetch does not blank the bar.
    if (quote) lastGood.set(symbols[i], quote);
    else failures++;
  });
  stale = failures > 0;
  cachedKey = key;
  // Stamp even on total failure so an upstream outage is not retried on every request.
  cachedAt = Date.now();
}

export async function GET() {
  try {
    const symbols = parseSymbols(process.env.TICKER_SYMBOLS);
    const key = symbols.join(",");

    if (cachedKey !== key || Date.now() - cachedAt >= CACHE_MS) {
      inflight ??= refresh(symbols, key)
        .catch(() => {
          // Keep serving last-good quotes; the next request past the cache window retries.
          stale = true;
          cachedAt = Date.now();
        })
        .finally(() => {
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
  } catch {
    return NextResponse.json(
      { quotes: [], stale: true, updatedAt: cachedAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
