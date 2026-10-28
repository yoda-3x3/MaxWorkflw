"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { MAX_AGENTS, MODEL_CHOICES, type RunIndexEntry, type RunOn, type RunOptions, type TeamShape, type UsageLimit } from "../../lib/types";
import { THEMES, applyTheme, currentTheme, isTheme, type Theme } from "../../lib/theme";
import { errorMessage, getPong, pingRunner, type NewRunInput } from "./api";
import { checkUploadSize, formatBytes } from "./attachments";
import { statusLabel, timeAgo, usageLabel, usagePercent, usageResetLabel } from "./format";
import { RepoPicker } from "./repoSelect";

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
  /** From the runner heartbeat; undefined until the first poll returns. */
  runnerOnline: boolean | undefined;
  error: string | null;
  selectedId: string | null;
  now: number;
  creating: boolean;
  createError: string | null;
  uploadProgress: UploadProgress | null;
  onSelect: (id: string) => void;
  onCreate: (input: NewRunInput, files: File[]) => void;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function RunSidebar({
  open,
  runs,
  usage,
  runnerOnline,
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
  const [runOn, setRunOn] = useState<RunOn>("auto");
  const [shape, setShape] = useState<TeamShape>("auto");
  const [maxAgents, setMaxAgents] = useState("");
  const [models, setModels] = useState<Record<"orchestrator" | "lead" | "worker", string>>({ orchestrator: "", lead: "", worker: "" });

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
    onCreate({ task: trimmedTask, repo: trimmedRepo || undefined, options: buildOptions() }, files);
    setTask("");
    setFiles([]);
  }

  // Only what differs from the defaults goes to the server.
  function buildOptions(): RunOptions | undefined {
    const o: RunOptions = {};
    if (runOn !== "auto") o.runOn = runOn;
    if (shape !== "auto") o.shape = shape;
    if (maxAgents.trim()) o.maxAgents = Number(maxAgents);
    const m = Object.fromEntries(Object.entries(models).filter(([, v]) => v)) as RunOptions["models"];
    if (m && Object.keys(m).length) o.models = m;
    return Object.keys(o).length ? o : undefined;
  }

  const pct = uploadProgress && uploadProgress.total > 0
    ? Math.round((uploadProgress.done / uploadProgress.total) * 100)
    : 0;

  return (
    <aside className="sidebar" data-open={open} data-no-gesture aria-label="Runs">
      <div className="brand">WorkflwPro</div>

      <RunnerPing online={runnerOnline} />

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
        <RepoPicker value={repo} onChange={setRepo} disabled={creating} />
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
        <details className="advanced">
          <summary>Advanced options</summary>
          <label>
            Run on
            <select value={runOn} onChange={(e) => setRunOn(e.target.value as RunOn)}>
              <option value="auto">Auto (PC if online, else cloud)</option>
              <option value="pc">My PC</option>
              <option value="cloud">Cloud (GitHub Actions)</option>
            </select>
          </label>
          <label>
            Team shape
            <select value={shape} onChange={(e) => setShape(e.target.value as TeamShape)}>
              <option value="auto">Auto (Orchestrator decides)</option>
              <option value="three-tier">3 tiers: Orchestrator → Leads → Workers</option>
              <option value="flat">Flat: Orchestrator → Agents</option>
            </select>
          </label>
          <label>
            Max agents (2–{MAX_AGENTS})
            <input
              type="number"
              min={2}
              max={MAX_AGENTS}
              value={maxAgents}
              onChange={(e) => setMaxAgents(e.target.value)}
              placeholder={String(MAX_AGENTS)}
            />
          </label>
          {(["orchestrator", "lead", "worker"] as const).map((role) => (
            <label key={role}>
              {role === "orchestrator" ? "Orchestrator" : role === "lead" ? "Lead" : "Worker"} model
              <select value={models[role]} onChange={(e) => setModels((prev) => ({ ...prev, [role]: e.target.value }))}>
                <option value="">Default</option>
                {MODEL_CHOICES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </details>
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

      <ThemePicker />
    </aside>
  );
}

const PING_TIMEOUT_MS = 45_000;
const PING_POLL_MS = 2_000;

/** PC runner status and a Ping button that waits for the runner to answer through its queue. */
function RunnerPing({ online }: { online: boolean | undefined }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "waiting" } | { kind: "ok"; ms: number; host?: string } | { kind: "none" } | { kind: "error"; msg: string }>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function ping() {
    if (timer.current) clearTimeout(timer.current);
    setState({ kind: "waiting" });
    try {
      const { nonce } = await pingRunner();
      const started = Date.now();
      const check = async () => {
        try {
          const pong = await getPong(nonce);
          if (pong.answered) return setState({ kind: "ok", ms: Date.now() - started, host: pong.host });
          if (Date.now() - started > PING_TIMEOUT_MS) return setState({ kind: "none" });
          timer.current = setTimeout(check, PING_POLL_MS);
        } catch (err) {
          setState({ kind: "error", msg: errorMessage(err) });
        }
      };
      timer.current = setTimeout(check, PING_POLL_MS);
    } catch (err) {
      setState({ kind: "error", msg: errorMessage(err) });
    }
  }

  return (
    <section className="runner" aria-label="PC runner">
      <span className="runner-status" data-online={online === undefined ? "unknown" : String(online)}>
        PC runner {online === undefined ? "…" : online ? "online" : "offline"}
      </span>
      <button type="button" onClick={ping} disabled={state.kind === "waiting"}>
        {state.kind === "waiting" ? "Pinging…" : "Ping"}
      </button>
      <span className="runner-ping muted" role="status">
        {state.kind === "ok" && `Answered in ${(state.ms / 1000).toFixed(1)} s${state.host ? ` (${state.host})` : ""}`}
        {state.kind === "none" && "No answer in 45 s. The PC is off, asleep, or busy with a run."}
        {state.kind === "error" && state.msg}
      </span>
    </section>
  );
}

function ThemePicker() {
  // The boot script has already applied the saved theme; read it after mount to avoid a hydration mismatch.
  const [theme, setTheme] = useState<Theme>("classic");
  useEffect(() => setTheme(currentTheme()), []);
  return (
    <label className="theme-picker">
      Theme
      <select
        value={theme}
        onChange={(e) => {
          if (!isTheme(e.target.value)) return;
          applyTheme(e.target.value);
          setTheme(e.target.value);
        }}
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id} title={t.about}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
