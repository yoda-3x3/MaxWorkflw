"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { Quote } from "../../app/api/ticker/parse";
import "./ticker.css";

const REFRESH_MS = 60_000;

function formatPrice(price: number): string {
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function TickerItem({ quote }: { quote: Quote }) {
  const { changePct } = quote;
  const direction = changePct === null ? "flat" : changePct >= 0 ? "up" : "down";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "";
  const change =
    changePct === null ? "—" : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;

  return (
    <li className={`ticker-item ticker-${direction}`}>
      <span className="ticker-symbol">{quote.symbol}</span>
      <span className="ticker-price">{formatPrice(quote.price)}</span>
      <span className="ticker-change">
        {arrow && <span className="ticker-arrow" aria-hidden="true">{arrow}</span>}
        {change}
      </span>
    </li>
  );
}

export default function StockTicker() {
  const [quotes, setQuotes] = useState<Quote[]>([]);

  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;

    async function load() {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/ticker", { cache: "no-store", signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { quotes?: Quote[] };
        if (alive && Array.isArray(data.quotes)) setQuotes(data.quotes);
      } catch {
        // Network error or abort: keep the previous quotes on screen.
      }
    }

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      controller?.abort();
    };
  }, []);

  // Nothing to show (first load, or the API has no data at all): render no bar.
  if (quotes.length === 0) return null;

  const items = quotes.map((q) => <TickerItem key={q.symbol} quote={q} />);

  return (
    <div
      className="ticker"
      data-ticker
      role="region"
      aria-label="Stock quotes"
      style={{ "--ticker-count": quotes.length } as CSSProperties}
    >
      <div className="ticker-track">
        <ul className="ticker-list">{items}</ul>
        {/* Duplicate copy makes the loop seamless; hidden from assistive tech. */}
        <ul className="ticker-list ticker-list--dup" aria-hidden="true">
          {items}
        </ul>
      </div>
    </div>
  );
}
