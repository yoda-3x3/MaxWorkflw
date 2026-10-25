import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VIEW_STORAGE_KEY,
  initialShellState,
  nextView,
  readStoredView,
  reduceShell,
  writeStoredView,
} from "./shellState";

test("gesture view-next and view-prev cycle through views and wrap", () => {
  let s = initialShellState;
  assert.equal(s.view, "wall");
  s = reduceShell(s, { type: "gesture", action: { type: "view-next" } });
  assert.equal(s.view, "tree");
  s = reduceShell(s, { type: "gesture", action: { type: "view-next" } });
  assert.equal(s.view, "timeline");
  s = reduceShell(s, { type: "gesture", action: { type: "view-next" } });
  assert.equal(s.view, "wall");
  s = reduceShell(s, { type: "gesture", action: { type: "view-prev" } });
  assert.equal(s.view, "timeline");
});

test("nextView handles both directions from every view", () => {
  assert.equal(nextView("wall", -1), "timeline");
  assert.equal(nextView("timeline", 1), "wall");
  assert.equal(nextView("tree", 1), "timeline");
});

test("refresh gesture bumps the tick that pollers watch", () => {
  const s = reduceShell(initialShellState, { type: "gesture", action: { type: "refresh" } });
  assert.equal(s.refreshTick, initialShellState.refreshTick + 1);
});

test("toggle-sidebar and toggle-fullscreen flip their flags", () => {
  let s = reduceShell(initialShellState, { type: "gesture", action: { type: "toggle-sidebar" } });
  assert.equal(s.sidebarOpen, false);
  s = reduceShell(s, { type: "gesture", action: { type: "toggle-fullscreen" } });
  assert.equal(s.fullscreen, true);
  s = reduceShell(s, { type: "gesture", action: { type: "toggle-fullscreen" } });
  assert.equal(s.fullscreen, false);
});

test("open-detail opens an agent only when an agentId is given", () => {
  const noId = reduceShell(initialShellState, { type: "gesture", action: { type: "open-detail" } });
  assert.equal(noId.detailAgentId, null);
  const withId = reduceShell(initialShellState, {
    type: "gesture",
    action: { type: "open-detail", agentId: "a1" },
  });
  assert.equal(withId.detailAgentId, "a1");
  const closed = reduceShell(withId, { type: "open-detail", agentId: null });
  assert.equal(closed.detailAgentId, null);
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

test("remembered view is read back and invalid values fall back to wall", () => {
  const s = fakeStorage();
  writeStoredView(s, "timeline");
  assert.equal(s.data.get(VIEW_STORAGE_KEY), "timeline");
  assert.equal(readStoredView(s), "timeline");
  assert.equal(readStoredView(fakeStorage({ [VIEW_STORAGE_KEY]: "bogus" })), "wall");
  assert.equal(readStoredView(null), "wall");
});

test("storage that throws is tolerated", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readStoredView(broken), "wall");
  assert.doesNotThrow(() => writeStoredView(broken, "tree"));
});
