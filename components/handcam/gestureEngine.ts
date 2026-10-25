import type { GestureAction } from './types';

// Gesture names as produced by MediaPipe GestureRecognizer.
export const GESTURE = {
  ClosedFist: 'Closed_Fist',
  OpenPalm: 'Open_Palm',
  PointingUp: 'Pointing_Up',
  ThumbUp: 'Thumb_Up',
} as const;

export const DEFAULT_CONFIG = {
  // Minimum classifier score before a gesture counts at all.
  minScore: 0.6,
  // How long a hold gesture must stay steady before it fires.
  holdMs: 600,
  // Global gap between any two fires, so one motion cannot trigger twice.
  cooldownMs: 1000,
  // Window in which an open-palm swipe has to cover the distance below.
  swipeWindowMs: 500,
  // Normalized (0..1 of frame width) horizontal wrist travel for a swipe.
  swipeMinDx: 0.2,
};
export type EngineConfig = typeof DEFAULT_CONFIG;

export interface GestureFrame {
  // Timestamp in ms, monotonic.
  t: number;
  // Top gesture category for this frame, or null when no hand is seen.
  gesture: string | null;
  score: number;
  // Wrist x in normalized image coordinates, when a hand is visible.
  wristX?: number;
  // Agent card under the pointer, if any. Only Thumb_Up uses it.
  hoveredAgentId?: string | null;
}

export interface EngineState {
  hold: { gesture: string; startedAt: number; fired: boolean } | null;
  swipe: { t: number; x: number }[];
  lastFiredAt: number;
}

export interface EngineStep {
  state: EngineState;
  actions: GestureAction[];
}

export function initialEngineState(): EngineState {
  return { hold: null, swipe: [], lastFiredAt: Number.NEGATIVE_INFINITY };
}

// Hold gestures and the action each one fires. Returning null means "no
// action available right now" (Thumb_Up with no hovered card); the hold keeps
// running, so the action fires once a card is hovered while the thumb stays up.
export const HOLD_ACTIONS: Record<
  string,
  ((hoveredAgentId: string | null) => GestureAction | null) | undefined
> = {
  [GESTURE.ClosedFist]: () => ({ type: 'refresh' }),
  [GESTURE.PointingUp]: () => ({ type: 'toggle-sidebar' }),
  [GESTURE.ThumbUp]: (hovered) =>
    hovered ? { type: 'open-detail', agentId: hovered } : null,
};

// Pure step: given the previous state and one classified frame, return the
// next state and any actions to dispatch. No timers, no DOM, no camera.
export function stepGestureEngine(
  state: EngineState,
  frame: GestureFrame,
  config: EngineConfig = DEFAULT_CONFIG,
): EngineStep {
  const gesture =
    frame.gesture !== null && frame.score >= config.minScore ? frame.gesture : null;
  const cooledDown = frame.t - state.lastFiredAt >= config.cooldownMs;
  const actions: GestureAction[] = [];
  let lastFiredAt = state.lastFiredAt;
  let swipe: EngineState['swipe'] = [];
  let hold: EngineState['hold'] = null;

  // Open-palm swipe: track wrist x over a short window.
  if (gesture === GESTURE.OpenPalm && frame.wristX !== undefined) {
    const samples = [...state.swipe, { t: frame.t, x: frame.wristX }].filter(
      (s) => frame.t - s.t <= config.swipeWindowMs,
    );
    const first = samples[0];
    const last = samples[samples.length - 1];
    // Raw camera x grows to the image's right, which is the user's left on an
    // unmirrored feed. Negate so a move to the user's right is positive.
    const dx = -(last.x - first.x);
    if (cooledDown && samples.length >= 2 && Math.abs(dx) >= config.swipeMinDx) {
      actions.push({ type: dx > 0 ? 'view-next' : 'view-prev' });
      lastFiredAt = frame.t;
    } else {
      swipe = samples;
    }
  }

  // Hold gestures: must stay steady for holdMs, then fire once per hold.
  const holdAction = gesture !== null ? HOLD_ACTIONS[gesture] : undefined;
  if (gesture !== null && holdAction) {
    let current: NonNullable<EngineState['hold']> =
      state.hold && state.hold.gesture === gesture
        ? state.hold
        : { gesture, startedAt: frame.t, fired: false };

    if (!current.fired && frame.t - current.startedAt >= config.holdMs && cooledDown) {
      const action = holdAction(frame.hoveredAgentId ?? null);
      if (action) {
        actions.push(action);
        lastFiredAt = frame.t;
        current = { ...current, fired: true };
      }
    }
    hold = current;
  }

  return { state: { hold, swipe, lastFiredAt }, actions };
}
