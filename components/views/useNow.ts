'use client';

import { useEffect, useState } from 'react';

// Current time in ms, re-rendered every `intervalMs`. Pass enabled=false when
// the parent supplies its own `now`, so no timer runs.
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);

  return now;
}
