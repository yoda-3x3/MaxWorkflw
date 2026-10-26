"use client";

import { useEffect, useRef, useState } from "react";
import type { ApprovalDecision, Run, RunIndexEntry } from "../../lib/types";

export const POLL_MS = 3000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

/** `runner.online` is false when the PC runner has not sent a heartbeat recently. */
export interface RunsResponse {
  runs: RunIndexEntry[];
  runner?: { online: boolean };
}

export function listRuns(): Promise<RunsResponse> {
  return request("/api/runs");
}

export function getRun(id: string): Promise<Run> {
  return request(`/api/runs/${encodeURIComponent(id)}`);
}

export function createRun(input: { task: string; repo?: string }): Promise<Run> {
  return request("/api/runs", { method: "POST", body: JSON.stringify(input) });
}

export function decideApproval(
  runId: string,
  approvalId: string,
  decision: ApprovalDecision["decision"],
): Promise<unknown> {
  return request(
    `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: "POST", body: JSON.stringify({ decision }) },
  );
}

export function mergeRun(runId: string): Promise<unknown> {
  return request(`/api/runs/${encodeURIComponent(runId)}/merge`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Calls `load` now and every `intervalMs`. Restarts immediately when `key` or `tick` changes
 * (tick is bumped by the "refresh" gesture). Passing `load` as null pauses polling.
 */
export function usePolling<T>(
  load: (() => Promise<T>) | null,
  key: string | null,
  tick: number,
  intervalMs = POLL_MS,
): { data: T | undefined; error: string | null } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setData(undefined);
    if (!loadRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tickOnce = async () => {
      try {
        const next = await loadRef.current!();
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
      if (!cancelled) timer = setTimeout(tickOnce, intervalMs);
    };
    void tickOnce();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, tick, intervalMs]);

  return { data, error };
}
