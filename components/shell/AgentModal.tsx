"use client";

import { useEffect, useRef } from "react";
import type { Agent, Approval } from "../../lib/types";
import { formatTokens } from "./format";

interface Props {
  agent: Agent | undefined;
  approval: Approval | undefined;
  now: number;
  onClose: () => void;
}

/** Full brief and report for one agent. Esc or the close button dismisses it. */
export function AgentModal({ agent, approval, now, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Keyed on open/closed, not the agent object: polling replaces that object every 3s.
  const open = agent !== undefined;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!agent) return null;

  const elapsedEnd = agent.endedAt ?? now;
  const elapsed = agent.startedAt ? elapsedEnd - agent.startedAt : 0;

  return (
    <div className="modal-backdrop" data-no-gesture onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Agent ${agent.title}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <p className="muted">
              Tier {agent.tier} · {agent.role} · {agent.model}
            </p>
            <h2>{agent.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <dl className="agent-stats">
          <div>
            <dt>Status</dt>
            <dd>{agent.status.replace("_", " ")}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{agent.attempts}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{formatTokens(agent.tokens)}</dd>
          </div>
          <div>
            <dt>Elapsed</dt>
            <dd>{Math.round(elapsed / 1000)}s</dd>
          </div>
        </dl>

        {approval && approval.status === "pending" && (
          <p className="form-error">Waiting on approval: {approval.request}</p>
        )}
        {agent.error && <p className="form-error">Error: {agent.error}</p>}

        <h3>Brief</h3>
        <pre className="text-block">{agent.brief || "(no brief)"}</pre>
        <h3>Report</h3>
        <pre className="text-block">{agent.report ?? "(no report yet)"}</pre>
      </div>
    </div>
  );
}
