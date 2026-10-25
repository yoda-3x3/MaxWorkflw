import { parseStooqCsv, parseYahooChart, stooqUrl, yahooUrl, type Quote } from "./parse";

// Per-attempt budget. Each symbol tries its sources in order, so the worst case for one
// symbol is the sum of these; all symbols run in parallel.
export const ATTEMPT_TIMEOUT_MS = 3_000;

// Yahoo rejects requests without a browser-like User-Agent.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface Source {
  url: (symbol: string) => string;
  parse: (text: string, symbol: string) => Quote | null;
}

// Order matters: primary Yahoo host, then the sibling host (separate rate limits), then Stooq.
const SOURCES: Source[] = [
  {
    url: (s) => yahooUrl(s, "query1"),
    parse: parseYahooJson,
  },
  {
    url: (s) => yahooUrl(s, "query2"),
    parse: parseYahooJson,
  },
  {
    url: stooqUrl,
    parse: (text, symbol) => {
      const parsed = parseStooqCsv(text)[0];
      // Report under the requested symbol so lookups never depend on Stooq's naming.
      return parsed ? { ...parsed, symbol } : null;
    },
  },
];

function parseYahooJson(text: string, symbol: string): Quote | null {
  try {
    return parseYahooChart(JSON.parse(text), symbol);
  } catch {
    return null;
  }
}

// Tries each source in turn and returns the first usable quote. Never throws: any network
// error, timeout, non-OK status, or unparseable body just moves on to the next source.
export async function fetchQuote(symbol: string, fetchImpl: FetchLike = fetch): Promise<Quote | null> {
  for (const source of SOURCES) {
    try {
      const res = await fetchImpl(source.url(symbol), {
        cache: "no-store",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT, Accept: "application/json, text/csv, */*" },
      });
      if (!res.ok) continue;
      const quote = source.parse(await res.text(), symbol);
      if (quote) return quote;
    } catch {
      // Fall through to the next source.
    }
  }
  return null;
}

// Fetches every symbol in parallel. Each entry is the fresh quote or null on total failure.
export async function fetchQuotes(
  symbols: string[],
  fetchImpl: FetchLike = fetch,
): Promise<(Quote | null)[]> {
  return Promise.all(symbols.map((s) => fetchQuote(s, fetchImpl).catch(() => null)));
}
