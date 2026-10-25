import type { Quote } from "../../app/api/ticker/parse";

/**
 * Quotes from a `/api/ticker` response body. Anything that is not an array of quotes
 * becomes an empty list, so the ticker hides instead of rendering a blank bar.
 */
export function quotesFromResponse(body: unknown): Quote[] {
  if (typeof body !== "object" || body === null) return [];
  const quotes = (body as { quotes?: unknown }).quotes;
  return Array.isArray(quotes) ? (quotes as Quote[]) : [];
}
