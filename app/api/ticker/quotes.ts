import { parseYahooChart, yahooUrl, type Quote } from "./parse";

// Per-attempt budget. A symbol tries at most two hosts, so the worst case for one symbol is
// twice this; all symbols run in parallel.
export const ATTEMPT_TIMEOUT_MS = 3_000;

// Yahoo rejects requests without a browser-like User-Agent.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Primary Yahoo host, then the sibling host (separate rate limits). Keyless, JSON only.
const HOSTS = ["query1", "query2"] as const;

// Tries each host in turn and returns the first usable quote. Never throws: any network
// error, timeout, non-OK status, or unparseable body just moves on to the next host.
export async function fetchQuote(symbol: string, fetchImpl: FetchLike = fetch): Promise<Quote | null> {
  for (const host of HOSTS) {
    try {
      const res = await fetchImpl(yahooUrl(symbol, host), {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) continue;
      const quote = parseYahooChart(JSON.parse(await res.text()), symbol);
      if (quote) return quote;
    } catch {
      // Fall through to the next host.
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
