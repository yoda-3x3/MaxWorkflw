"use client";

import { useState } from "react";
import type { Agent, Approval } from "../../lib/types";

interface Props {
  approvals: Approval[];
  agents: Agent[];
  onDecide: (approvalId: string, decision: "approved" | "denied") => Promise<void>;
}

const KIND_LABEL: Record<Approval["kind"], string> = {
  production_deploy: "Production deploy",
  destructive_op: "Destructive operation",
  paid_or_secret: "Paid service or secret",
  budget_exceeded: "Budget exceeded",
};

export function ApprovalCards({ approvals, agents, onDecide }: Props) {
  const pending = approvals.filter((a) => a.status === "pending");
  if (pending.length === 0) return null;

  return (
    <section className="approvals" aria-label="Pending approvals">
      <h2>Needs your approval</h2>
      {pending.map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          agentTitle={agents.find((g) => g.id === a.agentId)?.title ?? a.agentId}
          onDecide={onDecide}
        />
      ))}
    </section>
  );
}

function ApprovalCard({
  approval,
  agentTitle,
  onDecide,
}: {
  approval: Approval;
  agentTitle: string;
  onDecide: Props["onDecide"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approved" | "denied") {
    setBusy(true);
    setError(null);
    try {
      await onDecide(approval.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="approval-card">
      <p className="approval-kind">{KIND_LABEL[approval.kind]}</p>
      <p className="approval-agent">from {agentTitle}</p>
      <p>{approval.request}</p>
      <div className="approval-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => decide("approved")}>
          Approve
        </button>
        <button type="button" disabled={busy} onClick={() => decide("denied")}>
          Deny
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </article>
  );
}
