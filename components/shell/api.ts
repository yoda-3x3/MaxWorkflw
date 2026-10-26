"use client";

import { useEffect, useRef, useState } from "react";
import type { ApprovalDecision, Run, RunIndexEntry } from "../../lib/types";
import { chunkRanges, withRetry } from "./attachments";

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

/** Creates a draft run. It is not queued until `startRun` is called. */
export function createRun(input: { task: string; repo?: string }): Promise<Run> {
  return request("/api/runs", { method: "POST", body: JSON.stringify(input) });
}

/** Wire shape of an attached file (see RunFile in lib/types.ts once it lands). */
export interface RunFileMeta {
  id: string;
  runId: string;
  name: string;
  size: number;
  chunkBytes: number;
  chunks: number;
  complete: boolean;
  createdAt: number;
}

export function startRun(runId: string): Promise<Run> {
  return request(`/api/runs/${encodeURIComponent(runId)}/start`, { method: "POST" });
}

export function listRunFiles(runId: string): Promise<{ files: RunFileMeta[] }> {
  return request(`/api/runs/${encodeURIComponent(runId)}/files`);
}

function createRunFile(runId: string, input: { name: string; size: number }): Promise<RunFileMeta> {
  return request(`/api/runs/${encodeURIComponent(runId)}/files`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function uploadChunk(runId: string, fileId: string, n: number, bytes: Blob): Promise<unknown> {
  return request(
    `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(fileId)}/chunks/${n}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    },
  );
}

function completeRunFile(runId: string, fileId: string): Promise<RunFileMeta> {
  return request(
    `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(fileId)}/complete`,
    { method: "POST" },
  );
}

export function deleteRunFile(runId: string, fileId: string): Promise<unknown> {
  return request(`/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
  });
}

/**
 * Uploads one file in server-sized chunks, one request each. A failed chunk is retried on its
 * own; the file is completed only when every chunk is in. `onBytes` gets each chunk's size as
 * it lands, so the caller can drive a progress bar.
 */
export async function uploadRunFile(
  runId: string,
  file: File,
  onBytes: (bytes: number) => void,
): Promise<RunFileMeta> {
  const meta = await createRunFile(runId, { name: file.name, size: file.size });
  const ranges = chunkRanges(file.size, meta.chunkBytes);
  for (const range of ranges) {
    const blob = file.slice(range.start, range.end);
    await withRetry(() => uploadChunk(runId, meta.id, range.index, blob));
    onBytes(range.end - range.start);
  }
  return completeRunFile(runId, meta.id);
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
