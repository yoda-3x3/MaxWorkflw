// Pure gesture classifier. No DOM or React here, so it is unit-testable in Node.
// Times are milliseconds, distances are CSS pixels.

import type { GestureAction } from './actions';

export const GESTURE_TUNING = {
  // Horizontal swipe: long enough, quick enough, and clearly more horizontal than vertical.
  SWIPE_MIN_DISTANCE: 60,
  SWIPE_MAX_MS: 800,
  // Dominant axis must be this many times the other one. Keeps vertical scrolling untouched.
  AXIS_RATIO: 1.5,
  // Swipes starting this close to the left edge toggle the sidebar instead of changing view.
  EDGE_WIDTH: 24,
  // Pull down from the top of the scroll container to refresh.
  PULL_MIN_DISTANCE: 80,
  LONG_PRESS_MS: 500,
  // Movement beyond this cancels a long press and disqualifies a tap.
  LONG_PRESS_SLOP: 10,
  TAP_MAX_MS: 300,
  TAP_SLOP: 10,
  DOUBLE_TAP_MS: 300,
  DOUBLE_TAP_DISTANCE: 30,
} as const;

const T = GESTURE_TUNING;

export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

export interface PointerTrack {
  start: PointerSample;
  end: PointerSample;
  // Largest distance the pointer strayed from its start while down.
  maxMove: number;
  // Scroll offset of the nearest scrolling ancestor when the pointer went down.
  scrollTop: number;
}

export interface TapRecord {
  x: number;
  y: number;
  t: number;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function isTap(track: PointerTrack): boolean {
  return track.maxMove <= T.TAP_SLOP && track.end.t - track.start.t <= T.TAP_MAX_MS;
}

export function isLongPressCancelled(maxMove: number): boolean {
  return maxMove > T.LONG_PRESS_SLOP;
}

// Maps a finished pointer track to one action, or null if it is not a gesture.
// Taps are not classified here; use isTap and nextTapState for those.
export function classifyTrack(track: PointerTrack): GestureAction | null {
  const dx = track.end.x - track.start.x;
  const dy = track.end.y - track.start.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const elapsed = track.end.t - track.start.t;

  if (adx >= SWIPE_AXIS(adx, ady) && adx >= T.SWIPE_MIN_DISTANCE && elapsed <= T.SWIPE_MAX_MS) {
    if (track.start.x <= T.EDGE_WIDTH) return { type: 'toggle-sidebar' };
    // Finger moving left reveals what is to the right, so it is "next".
    return { type: dx < 0 ? 'view-next' : 'view-prev' };
  }

  if (dy >= T.PULL_MIN_DISTANCE && ady >= adx * T.AXIS_RATIO && track.scrollTop <= 0) {
    return { type: 'refresh' };
  }

  return null;
}

// Helper so the horizontal test reads as "adx dominates ady".
function SWIPE_AXIS(adx: number, ady: number): number {
  return ady * T.AXIS_RATIO;
}

// Double-tap state machine. Feed each tap in order; `doubleTap` is true on the second tap of a pair.
// After a double tap `last` is cleared, so a third quick tap starts a new pair instead of firing again.
export function nextTapState(
  prev: TapRecord | null,
  tap: TapRecord,
): { doubleTap: boolean; last: TapRecord | null } {
  if (prev && tap.t - prev.t <= T.DOUBLE_TAP_MS && distance(prev, tap) <= T.DOUBLE_TAP_DISTANCE) {
    return { doubleTap: true, last: null };
  }
  return { doubleTap: false, last: tap };
}

// Keyboard equivalents. Modifier handling and editable-target checks belong to the caller.
export function keyToAction(key: string): GestureAction | null {
  switch (key) {
    case 'ArrowRight':
      return { type: 'view-next' };
    case 'ArrowLeft':
      return { type: 'view-prev' };
    case '[':
      return { type: 'toggle-sidebar' };
    case 'r':
    case 'R':
      return { type: 'refresh' };
    default:
      return null;
  }
}
