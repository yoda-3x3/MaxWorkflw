import type { GestureAction } from "../gestures/actions";

export const VIEWS = ["wall", "tree", "timeline"] as const;
export type ViewId = (typeof VIEWS)[number];

export const VIEW_STORAGE_KEY = "workflwpro.view";

export interface ShellState {
  view: ViewId;
  sidebarOpen: boolean;
  fullscreen: boolean;
  detailAgentId: string | null;
  // Bumped by "refresh" so pollers re-fetch immediately.
  refreshTick: number;
}

export const initialShellState: ShellState = {
  view: "wall",
  sidebarOpen: true,
  fullscreen: false,
  detailAgentId: null,
  refreshTick: 0,
};

export type ShellEvent =
  | { type: "gesture"; action: GestureAction }
  | { type: "set-view"; view: ViewId }
  | { type: "toggle-sidebar" }
  | { type: "open-detail"; agentId: string | null }
  | { type: "refresh" };

export function isViewId(value: unknown): value is ViewId {
  return typeof value === "string" && (VIEWS as readonly string[]).includes(value);
}

export function nextView(view: ViewId, step: 1 | -1): ViewId {
  const i = VIEWS.indexOf(view);
  return VIEWS[(i + step + VIEWS.length) % VIEWS.length];
}

export function reduceShell(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case "set-view":
      return { ...state, view: event.view };
    case "toggle-sidebar":
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case "open-detail":
      return { ...state, detailAgentId: event.agentId };
    case "refresh":
      return { ...state, refreshTick: state.refreshTick + 1 };
    case "gesture":
      return reduceGesture(state, event.action);
  }
}

// Single action handler shared by GestureLayer and HandCamToggle.
function reduceGesture(state: ShellState, action: GestureAction): ShellState {
  switch (action.type) {
    case "view-next":
      return { ...state, view: nextView(state.view, 1) };
    case "view-prev":
      return { ...state, view: nextView(state.view, -1) };
    case "refresh":
      return { ...state, refreshTick: state.refreshTick + 1 };
    case "toggle-sidebar":
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case "open-detail":
      // Without an agentId there is nothing to open.
      return action.agentId ? { ...state, detailAgentId: action.agentId } : state;
    case "toggle-fullscreen":
      return { ...state, fullscreen: !state.fullscreen };
    default:
      return state;
  }
}

// Storage is passed in so this stays pure and testable; pass null on the server.
export function readStoredView(storage: Pick<Storage, "getItem"> | null): ViewId {
  try {
    const raw = storage?.getItem(VIEW_STORAGE_KEY);
    return isViewId(raw) ? raw : initialShellState.view;
  } catch {
    // Storage can throw (privacy mode, locked-down browsers); fall back to default.
    return initialShellState.view;
  }
}

export function writeStoredView(storage: Pick<Storage, "setItem"> | null, view: ViewId): void {
  try {
    storage?.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Ignore: the choice just won't persist.
  }
}
