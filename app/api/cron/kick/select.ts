import type { Run } from "@/lib/types";

/** A run counts as stalled when nothing has written to it for this long. */
export const STALE_AFTER_MS = 3 * 60 * 1000;
/** Caps the fan-out per invocation. The next cron tick picks up anything left over. */
export const MAX_KICKS = 20;

/**
 * The stalled runs to re-dispatch, oldest first, capped at MAX_KICKS. Terminal runs and runs
 * waiting on approval are skipped: nothing can progress for them without a human or without
 * a new event.
 */
export function selectStale(runs: (Run | null)[], now: number): Run[] {
  const cutoff = now - STALE_AFTER_MS;
  return runs
    .filter((run): run is Run => run !== null && isStalled(run, cutoff))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, MAX_KICKS);
}

function isStalled(run: Run, cutoff: number): boolean {
  if (run.status === "done" || run.status === "failed") return false;
  if (run.status === "waiting_approval") return false;
  return run.updatedAt < cutoff;
}
