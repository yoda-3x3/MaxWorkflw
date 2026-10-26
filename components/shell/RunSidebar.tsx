"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import type { RunIndexEntry, UsageLimit } from "../../lib/types";
import { checkUploadSize, formatBytes } from "./attachments";
import { statusLabel, timeAgo, usageLabel, usagePercent, usageResetLabel } from "./format";

/** Bytes uploaded so far for the run being started, out of the total. Null when not uploading. */
export interface UploadProgress {
  done: number;
  total: number;
}

interface Props {
  open: boolean;
  runs: RunIndexEntry[] | undefined;
  /** Claude subscription usage per limit window; empty until the runner has made a call. */
  usage: UsageLimit[] | undefined;
  error: string | null;
  selectedId: string | null;
  now: number;
  creating: boolean;
  createError: string | null;
  uploadProgress: UploadProgress | null;
  onSelect: (id: string) => void;
  onCreate: (input: { task: string; repo?: string }, files: File[]) => void;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function RunSidebar({
  open,
  runs,
  usage,
  error,
  selectedId,
  now,
  creating,
  createError,
  uploadProgress,
  onSelect,
  onCreate,
}: Props) {
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);

  const sizeCheck = checkUploadSize(files);
  const sizeError = sizeCheck.ok ? null : sizeCheck.error;

  function addFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    // Clear the input so picking the same file again still fires onChange.
    e.target.value = "";
    if (picked.length) setFiles((prev) => [...prev, ...picked]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmedRepo = repo.trim();
    if (trimmedRepo && !REPO_RE.test(trimmedRepo)) {
      setRepoError("Use owner/name, e.g. yoda-3x3/WorkflwPro");
      return;
    }
    setRepoError(null);
    const trimmedTask = task.trim();
    if (!trimmedTask || sizeError) return;
    onCreate({ task: trimmedTask, repo: trimmedRepo || undefined }, files);
    setTask("");
    setFiles([]);
  }

  const pct = uploadProgress && uploadProgress.total > 0
    ? Math.round((uploadProgress.done / uploadProgress.total) * 100)
    : 0;

  return (
    <aside className="sidebar" data-open={open} data-no-gesture aria-label="Runs">
      <div className="brand">WorkflwPro</div>

      <section className="usage" aria-label="Claude usage">
        <h2>Claude usage</h2>
        {!usage?.length ? (
          <p className="muted">Shows up after the runner's first Claude call.</p>
        ) : (
          <ul>
            {usage.map((u) => {
              const pct = usagePercent(u.utilization);
              const level = u.status === "rejected" || pct >= 90 ? "bad" : pct >= 75 ? "warn" : "ok";
              return (
                <li key={u.type} className="usage-row" data-level={level}>
                  <span className="usage-name">{usageLabel(u.type)}</span>
                  <span className="usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${usageLabel(u.type)} usage`}>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  <span className="usage-pct">{Math.round(pct)}%</span>
                  {typeof u.resetsAt === "number" && <span className="usage-reset muted">{usageResetLabel(u.resetsAt, now)}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <form className="new-run" onSubmit={submit}>
        <h2>New run</h2>
        <label>
          Task
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={4}
            placeholder="What should the team do?"
            required
          />
        </label>
        <label>
          Repo (optional)
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          Attachments (optional, up to 20 files, 90 MB total)
          <input type="file" multiple onChange={addFiles} disabled={creating} />
        </label>
        {files.length > 0 && (
          <ul className="attachment-list" aria-label="Attached files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <span className="attachment-name">{f.name}</span>
                <span className="muted">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  disabled={creating}
                  aria-label={`Remove ${f.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {sizeError && <p className="form-error">{sizeError}</p>}
        {repoError && <p className="form-error">{repoError}</p>}
        {createError && <p className="form-error">{createError}</p>}
        {uploadProgress && (
          <div className="upload-progress">
            <progress value={uploadProgress.done} max={Math.max(uploadProgress.total, 1)} aria-label="Upload progress" />
            <span className="muted">
              Uploading {pct}% ({formatBytes(uploadProgress.done)} of {formatBytes(uploadProgress.total)})
            </span>
          </div>
        )}
        <button type="submit" className="primary" disabled={creating || !task.trim() || Boolean(sizeError)}>
          {creating ? (uploadProgress ? "Uploading…" : "Starting…") : "Start run"}
        </button>
      </form>

      <section className="history">
        <h2>History</h2>
        {error && <p className="form-error">Could not load runs: {error}</p>}
        {!runs && !error && <p className="muted">Loading…</p>}
        {runs && runs.length === 0 && <p className="muted">No runs yet.</p>}
        <ul>
          {runs?.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="history-item"
                aria-current={r.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(r.id)}
              >
                <span className="history-task">{r.task}</span>
                <span className="history-meta">
                  <span className={`status status-${r.status}`}>{statusLabel(r.status)}</span>
                  {r.repo && <span>{r.repo}</span>}
                  <span>{timeAgo(r.createdAt, now)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
