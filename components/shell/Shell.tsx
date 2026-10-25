"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { GestureLayer, type GestureAction } from "../gestures";
import HandCamToggle from "../handcam/HandCamToggle";
import { TimelineView, TreeView, WallView } from "../views";
import { ActivityLog } from "./ActivityLog";
import { AgentModal } from "./AgentModal";
import { ApprovalCards } from "./ApprovalCards";
import { RunHeader } from "./RunHeader";
import { RunSidebar } from "./RunSidebar";
import { ViewSwitcher } from "./ViewSwitcher";
import {
  createRun,
  decideApproval,
  errorMessage,
  getRun,
  kickRun,
  listRuns,
  mergeRun,
  usePolling,
} from "./api";
import { initialShellState, reduceShell, readStoredView, writeStoredView } from "./shellState";

export function Shell() {
  const [shell, dispatch] = useReducer(reduceShell, initialShellState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [hydrated, setHydrated] = useState(false);

  // Restore the remembered view after mount (localStorage is unavailable during SSR).
  useEffect(() => {
    dispatch({ type: "set-view", view: readStoredView(window.localStorage) });
    setHydrated(true);
  }, []);

  // Skip the write before hydration so it can't overwrite the stored choice.
  useEffect(() => {
    if (hydrated) writeStoredView(window.localStorage, shell.view);
  }, [hydrated, shell.view]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Single action handler for GestureLayer and HandCamToggle.
  const onAction = useCallback((action: GestureAction) => {
    dispatch({ type: "gesture", action });
  }, []);

  const loadRuns = useCallback(async () => (await listRuns()).runs, []);
  const runs = usePolling(loadRuns, "runs", shell.refreshTick);

  const loadRun = useCallback(
    () => getRun(selectedId ?? ""),
    [selectedId],
  );
  const run = usePolling(selectedId ? loadRun : null, selectedId, shell.refreshTick);
  const current = run.data;

  // Opening a run kicks it, in case its cloud driver stalled.
  useEffect(() => {
    if (!selectedId) return;
    kickRun(selectedId).catch(() => {
      // Harmless: the cron route and the next poll will kick it again.
    });
  }, [selectedId]);

  async function handleCreate(input: { task: string; repo?: string }) {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createRun(input);
      setSelectedId(created.id);
      dispatch({ type: "refresh" });
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDecide(approvalId: string, decision: "approved" | "denied") {
    if (!current) return;
    await decideApproval(current.id, approvalId, decision);
    dispatch({ type: "refresh" });
  }

  async function handleMerge() {
    if (!current) return;
    await mergeRun(current.id);
    dispatch({ type: "refresh" });
  }

  const detailAgent = current?.agents.find((a) => a.id === shell.detailAgentId);
  const detailApproval = current?.approvals.find(
    (a) => a.agentId === shell.detailAgentId && a.status === "pending",
  );
  const closeDetail = useCallback(() => dispatch({ type: "open-detail", agentId: null }), []);

  const pendingApprovals = current?.approvals.filter((a) => a.status === "pending") ?? [];

  return (
    <GestureLayer onAction={onAction}>
    <div className="shell" data-sidebar={shell.sidebarOpen} data-fullscreen={shell.fullscreen}>
      <RunSidebar
        open={shell.sidebarOpen}
        runs={runs.data}
        error={runs.error}
        selectedId={selectedId}
        now={now}
        creating={creating}
        createError={createError}
        onSelect={(id) => {
          setSelectedId(id);
          dispatch({ type: "open-detail", agentId: null });
        }}
        onCreate={handleCreate}
      />

      <main className="shell-main">
        <div className="shell-toolbar">
          <button
            type="button"
            onClick={() => dispatch({ type: "toggle-sidebar" })}
            aria-expanded={shell.sidebarOpen}
            aria-label="Toggle run sidebar"
          >
            ☰
          </button>
          <button type="button" onClick={() => dispatch({ type: "refresh" })}>
            Refresh
          </button>
        </div>

        {!selectedId && (
          <p className="empty-state">Start a run on the left, or pick one from history.</p>
        )}

        {selectedId && run.error && !current && (
          <p className="form-error">Could not load run: {run.error}</p>
        )}

        {current && (
          <>
            <RunHeader run={current} now={now} onMerge={handleMerge} />
            <ApprovalCards
              approvals={pendingApprovals}
              agents={current.agents}
              onDecide={handleDecide}
            />
            {current.finalReport && (
              <section className="final-report" aria-label="Final report">
                <h2>Final report</h2>
                <pre className="text-block" data-no-gesture>{current.finalReport}</pre>
              </section>
            )}

            <ViewSwitcher view={shell.view} onChange={(view) => dispatch({ type: "set-view", view })} />

            <div className="view-body">
              {shell.view === "wall" && (
                <WallView agents={current.agents} onSelect={(a) => dispatch({ type: "open-detail", agentId: a.id })} />
              )}
              {shell.view === "tree" && (
                <TreeView agents={current.agents} onSelect={(a) => dispatch({ type: "open-detail", agentId: a.id })} />
              )}
              {shell.view === "timeline" && (
                <TimelineView
                  agents={current.agents}
                  now={now}
                  onSelect={(a) => dispatch({ type: "open-detail", agentId: a.id })}
                />
              )}
            </div>

            <ActivityLog events={current.events} agents={current.agents} />
          </>
        )}
      </main>

      <AgentModal agent={detailAgent} approval={detailApproval} now={now} onClose={closeDetail} />

      <HandCamToggle onAction={onAction} />
    </div>
    </GestureLayer>
  );
}
