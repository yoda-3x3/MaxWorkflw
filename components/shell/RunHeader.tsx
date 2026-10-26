"use client";

import { useState } from "react";
import { MAX_AGENTS, type Run, type RunFile } from "../../lib/types";
import { formatBytes } from "./attachments";
import {
  agentCountLabel,
  deadlineLabel,
  deadlineProgress,
  formatTokens,
  isRunnerStarting,
  prLabel,
} from "./format";

interface Props {
  run: Run;
  files?: RunFile[];
  now: number;
  onMerge: () => Promise<void>;
}

const TERMINAL = new Set(["done", "failed"]);

export function RunHeader({ run, files, now, onMerge }: Props) {
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const prText = prLabel(run.repo, run.prNumber);
  const canMerge = Boolean(run.prUrl) && run.status === "done";
  const active = !TERMINAL.has(run.status);
  const progress = deadlineProgress(run.createdAt, run.deadlineAt, now);

  async function confirmMerge() {
    const label = prText ?? "this PR";
    // Only the owner can merge; the server enforces that too.
    if (!window.confirm(`Merge ${label}? This is your click, and it cannot be undone from here.`)) {
      return;
    }
    setMerging(true);
    setMergeError(null);
    try {
      await onMerge();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  }

  return (
    <header className="run-header">
      <div className="run-title">
        <span className={`status status-${run.status}`}>{run.status.replace("_", " ")}</span>
        <h1>{run.task}</h1>
      </div>

      {run.plan && <p className="plan-summary">{run.plan.summary}</p>}
      {run.error && <p className="form-error">{run.error}</p>}

      <dl className="run-stats">
        <div>
          <dt>Agents</dt>
          <dd>{agentCountLabel(run.agents.length)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{formatTokens(run.tokens)}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>{deadlineLabel(run.deadlineAt, now)}</dd>
          <progress value={progress} max={1} aria-label="Share of deadline used" />
        </div>
        {run.repo && (
          <div>
            <dt>Repo</dt>
            <dd>{run.repo}</dd>
          </div>
        )}
      </dl>

      {files && files.length > 0 && (
        <section className="attached-files" aria-label="Attached files">
          <h3>Attached files</h3>
          <ul>
            {files.map((f) => (
              <li key={f.id}>
                <span className="attachment-name">{f.name}</span>{" "}
                <span className="muted">
                  {formatBytes(f.size)}
                  {!f.complete && " (incomplete)"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isRunnerStarting(run) && <p className="muted">runner starting...</p>}

      {active && (
        <p className="cloud-note">
          Runs on your PC runner with your Claude subscription. Safe to close this tab.
        </p>
      )}

      {(run.prUrl || canMerge) && (
        <div className="pr-row">
          {run.prUrl && (
            <a href={run.prUrl} target="_blank" rel="noreferrer">
              {prText ? `PR ${prText}` : "Open PR"}
            </a>
          )}
          {canMerge && (
            <button type="button" className="danger" onClick={confirmMerge} disabled={merging}>
              {merging ? "Merging…" : "Merge PR"}
            </button>
          )}
        </div>
      )}
      {mergeError && <p className="form-error">Merge failed: {mergeError}</p>}
      {run.agents.length >= MAX_AGENTS && (
        <p className="muted">Agent cap reached ({MAX_AGENTS}).</p>
      )}
    </header>
  );
}
