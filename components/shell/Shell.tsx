"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { GestureLayer, type GestureAction } from "../gestures";
import HandCamToggle from "../handcam/HandCamToggle";
import { TimelineView, TreeView, WallView } from "../views";
import { ActivityLog } from "./ActivityLog";
import { AgentModal } from "./AgentModal";
import { ApprovalCards } from "./ApprovalCards";
import { RunHeader } from "./RunHeader";
import { RunSidebar, type UploadProgress } from "./RunSidebar";
import { ViewSwitcher } from "./ViewSwitcher";
import {
  createRun,
  decideApproval,
  errorMessage,
  getRun,
  listRunFiles,
  listRuns,
  mergeRun,
  startRun,
  uploadRunFile,
  usePolling,
  type NewRunInput,
} from "./api";
import { initialShellState, reduceShell, readStoredView, writeStoredView } from "./shellState";

export function Shell() {
  const [shell, dispatch] = useReducer(reduceShell, initialShellState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
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

  const runsPoll = usePolling(listRuns, "runs", shell.refreshTick);
  const runs = runsPoll.data?.runs;
  // Only a reported `online: false` shows the banner; an older API without `runner` shows nothing.
  const runnerOffline = runsPoll.data?.runner?.online === false;

  const loadRun = useCallback(
    () => getRun(selectedId ?? ""),
    [selectedId],
  );
  const run = usePolling(selectedId ? loadRun : null, selectedId, shell.refreshTick);
  const current = run.data;

  const loadFiles = useCallback(
    async () => (await listRunFiles(selectedId ?? "")).files,
    [selectedId],
  );
  const files = usePolling(selectedId ? loadFiles : null, selectedId, shell.refreshTick);

  // Draft -> upload each file (chunked, sequential) -> start. A failure after the draft exists
  // keeps the draft and selects it, so the owner can see what was saved.
  async function handleCreate(input: NewRunInput, files: File[]) {
    setCreating(true);
    setCreateError(null);
    const total = files.reduce((sum, f) => sum + f.size, 0);
    let draftId: string | null = null;
    try {
      const draft = await createRun(input);
      draftId = draft.id;
      let done = 0;
      setUploadProgress({ done, total });
      for (const file of files) {
        await uploadRunFile(draft.id, file, (bytes) => {
          done += bytes;
          setUploadProgress({ done, total });
        });
      }
      const started = await startRun(draft.id);
      if (started.cloudError) setCreateError(`Queued for the cloud, but: ${started.cloudError}`);
      setSelectedId(draft.id);
      dispatch({ type: "refresh" });
    } catch (err) {
      if (draftId) setSelectedId(draftId);
      const note = draftId ? " The run was saved as a draft and not started." : "";
      setCreateError(`${errorMessage(err)}${note}`);
      dispatch({ type: "refresh" });
    } finally {
      setCreating(false);
      setUploadProgress(null);
    }
  }

  async function handleDecide(approvalId: string, decision: "approved" | "denied") {
    if (!current) return;
    await decideApproval(current.id, approvalId, decision);
    dispatch({ type: "refresh" });
  }

  // Starts a draft whose uploads are complete. The server rejects an incomplete file with 409.
  async function handleStart() {
    if (!current) return;
    await startRun(current.id);
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
        runs={runs}
        usage={runsPoll.data?.usage}
        runnerOnline={runsPoll.data?.runner?.online}
        error={runsPoll.error}
        selectedId={selectedId}
        now={now}
        creating={creating}
        createError={createError}
        uploadProgress={uploadProgress}
        onSelect={(id) => {
          setSelectedId(id);
          dispatch({ type: "open-detail", agentId: null });
        }}
        onCreate={handleCreate}
      />

      <main className="shell-main">
        {runnerOffline && (
          <div role="alert" className="runner-offline">
            <strong>PC runner offline.</strong> New runs on Auto go to the cloud runner; runs set to PC wait for it.
          </div>
        )}

        <div className="shell-toolbar">
          <span className="brand">WorkflwPro</span>
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
            <RunHeader
              run={current}
              files={files.data}
              now={now}
              onMerge={handleMerge}
              onStart={handleStart}
            />
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
