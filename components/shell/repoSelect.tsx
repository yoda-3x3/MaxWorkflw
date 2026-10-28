"use client";

import { useEffect, useId, useState } from "react";
import {
  REPO_PICKER_MAX_REPOS,
  REPO_SELECT_MANUAL,
  REPO_SELECT_NONE,
  loadRepoPages,
  repoSelectLabel,
  repoSelectOptions,
  selectOptionValue,
  validateNewRepoName,
  withRepoListed,
  type GitHubRepoSummary,
} from "../../lib/githubRepos";
import { createGitHubRepo, errorMessage, listGitHubRepos } from "./api";
import "./repoField.css";

// Filter box appears only when there are enough repos to need it.
const FILTER_MIN_REPOS = 8;
const LIST_PAGE_SIZE = 100;

type ListState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

/**
 * Repo field for the run form. A native select comes first, so it works on touch screens.
 * "Type owner/name manually…" and the text fallback cover loading, error and empty states.
 * A repo created here is selected even when the list does not have it.
 */
export function RepoPicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const labelId = useId();
  const selectId = useId();
  const filterId = useId();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [repos, setRepos] = useState<GitHubRepoSummary[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrivate, setNewPrivate] = useState(true);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Loads the list once on mount, and again only when the user presses Try again.
  useEffect(() => {
    let cancelled = false;
    setList({ kind: "loading" });
    loadRepoPages((page) => listGitHubRepos("", page, LIST_PAGE_SIZE))
      .then((res) => {
        if (cancelled) return;
        setRepos(res.repos);
        setTruncated(res.truncated);
        setList({ kind: "ready" });
      })
      .catch((err: unknown) => {
        if (!cancelled) setList({ kind: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const selected = selectOptionValue(value, repos, manualOpen);
  const options = repoSelectOptions(repos, filter, selected === REPO_SELECT_MANUAL ? "" : selected);
  const showText = list.kind !== "ready" || repos.length === 0 || selected === REPO_SELECT_MANUAL || manualOpen;

  function pick(next: string) {
    if (next === REPO_SELECT_MANUAL) {
      setManualOpen(true);
      onChange("");
      return;
    }
    setManualOpen(false);
    onChange(next);
  }

  async function createRepo() {
    const name = newName.trim();
    const invalid = validateNewRepoName(name);
    if (invalid) return setCreateError(invalid);
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await createGitHubRepo({ name, private: newPrivate });
      setRepos((prev) => withRepoListed(prev, created));
      onChange(created.fullName);
      setManualOpen(false);
      setNewName("");
      setCreateOpen(false);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <div className="repo-field">
      <span className="repo-label" id={labelId}>Repo (optional)</span>

      {list.kind === "loading" && (
        <p className="repo-status muted" role="status">Loading your repos…</p>
      )}

      {list.kind === "error" && (
        <div className="repo-status">
          <p className="form-error" role="alert">Repo list unavailable: {list.message}</p>
          <button type="button" className="repo-retry" onClick={() => setAttempt((n) => n + 1)} disabled={disabled}>
            Try again
          </button>
        </div>
      )}

      {list.kind === "ready" && repos.length === 0 && (
        <p className="repo-status muted">No repos found for this token. Type owner/name below.</p>
      )}

      {list.kind === "ready" && repos.length > 0 && (
        <>
          {repos.length > FILTER_MIN_REPOS && (
            <input
              id={filterId}
              type="search"
              className="repo-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter repos"
              aria-label="Filter repos"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
            />
          )}
          <select
            id={selectId}
            className="repo-select"
            aria-labelledby={labelId}
            value={selected}
            onChange={(e) => pick(e.target.value)}
            disabled={disabled}
          >
            <option value={REPO_SELECT_NONE}>No repo</option>
            {options.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {repoSelectLabel(r)}
              </option>
            ))}
            <option value={REPO_SELECT_MANUAL}>Type owner/name manually…</option>
          </select>
          {truncated && (
            <p className="repo-status muted">Showing the first {REPO_PICKER_MAX_REPOS} repos. Type owner/name for others.</p>
          )}
        </>
      )}

      {showText && (
        <input
          type="text"
          className="repo-manual"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Repo as owner/name"
          placeholder="owner/name"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      )}

      <button
        type="button"
        className="repo-create-toggle"
        onClick={() => setCreateOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={createOpen}
      >
        {createOpen ? "Cancel new repo" : "Create new repo"}
      </button>

      {createOpen && (
        <div className="repo-create">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void createRepo();
              }
            }}
            placeholder="new-repo-name"
            aria-label="New repo name"
            autoComplete="off"
            spellCheck={false}
            disabled={createBusy}
          />
          <div className="repo-create-row">
            <label>
              <input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} disabled={createBusy} />
              {" "}Private
            </label>
            <button type="button" onClick={() => void createRepo()} disabled={createBusy || !newName.trim()}>
              {createBusy ? "Creating…" : "Create and select"}
            </button>
          </div>
          {createError && <p className="form-error">{createError}</p>}
        </div>
      )}
    </div>
  );
}
