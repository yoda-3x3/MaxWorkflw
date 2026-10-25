"use client";

import { VIEWS, type ViewId } from "./shellState";

const LABELS: Record<ViewId, string> = {
  wall: "Wall",
  tree: "Tree",
  timeline: "Timeline",
};

export function ViewSwitcher({ view, onChange }: { view: ViewId; onChange: (v: ViewId) => void }) {
  return (
    <div className="view-switcher" role="tablist" aria-label="Agent view">
      {VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={v === view}
          className={v === view ? "active" : undefined}
          onClick={() => onChange(v)}
        >
          {LABELS[v]}
        </button>
      ))}
    </div>
  );
}
