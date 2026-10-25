import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  GESTURE,
  initialEngineState,
  stepGestureEngine,
  type EngineState,
  type GestureFrame,
} from '../components/handcam/gestureEngine';
import type { GestureAction } from '../components/handcam/types';

// Runs a list of frames through the pure step function and collects every action.
function run(frames: GestureFrame[]) {
  let state: EngineState = initialEngineState();
  const actions: { t: number; action: GestureAction }[] = [];
  for (const frame of frames) {
    const step = stepGestureEngine(state, frame);
    state = step.state;
    for (const action of step.actions) actions.push({ t: frame.t, action });
  }
  return { state, actions: actions.map((a) => a.action) };
}

// Steady hold of one gesture at 15fps (~67ms) from t0 for durationMs.
function hold(gesture: string | null, t0: number, durationMs: number, extra: Partial<GestureFrame> = {}) {
  const frames: GestureFrame[] = [];
  for (let t = t0; t <= t0 + durationMs; t += 67) {
    frames.push({ t, gesture, score: 0.9, ...extra });
  }
  return frames;
}

// Open palm with the wrist sliding from x0 to x1 over durationMs.
function swipe(x0: number, x1: number, t0: number, durationMs: number): GestureFrame[] {
  const frames: GestureFrame[] = [];
  const steps = Math.max(1, Math.round(durationMs / 67));
  for (let i = 0; i <= steps; i++) {
    frames.push({
      t: t0 + (i * durationMs) / steps,
      gesture: GESTURE.OpenPalm,
      score: 0.9,
      wristX: x0 + ((x1 - x0) * i) / steps,
    });
  }
  return frames;
}

test('closed fist held past holdMs fires refresh exactly once', () => {
  const { actions } = run(hold(GESTURE.ClosedFist, 0, 2000));
  assert.deepEqual(actions, [{ type: 'refresh' }]);
});

test('no fire before holdMs has elapsed', () => {
  const { actions } = run(hold(GESTURE.ClosedFist, 0, DEFAULT_CONFIG.holdMs - 100));
  assert.deepEqual(actions, []);
});

test('pointing up held fires toggle-sidebar', () => {
  const { actions } = run(hold(GESTURE.PointingUp, 0, 1000));
  assert.deepEqual(actions, [{ type: 'toggle-sidebar' }]);
});

test('thumb up on hovered agent card fires open-detail with agentId', () => {
  const { actions } = run(hold(GESTURE.ThumbUp, 0, 1000, { hoveredAgentId: 'agent-7' }));
  assert.deepEqual(actions, [{ type: 'open-detail', agentId: 'agent-7' }]);
});

test('thumb up with no hovered card never fires', () => {
  const { actions } = run(hold(GESTURE.ThumbUp, 0, 3000, { hoveredAgentId: null }));
  assert.deepEqual(actions, []);
});

test('thumb up held before hovering fires once the pointer lands on a card', () => {
  const frames = [
    ...hold(GESTURE.ThumbUp, 0, 1000, { hoveredAgentId: null }),
    ...hold(GESTURE.ThumbUp, 1067, 300, { hoveredAgentId: 'agent-2' }),
  ];
  const { actions } = run(frames);
  assert.deepEqual(actions, [{ type: 'open-detail', agentId: 'agent-2' }]);
});

test('low-score gestures are ignored', () => {
  const frames = hold(GESTURE.ClosedFist, 0, 2000).map((f) => ({ ...f, score: DEFAULT_CONFIG.minScore - 0.01 }));
  const { actions } = run(frames);
  assert.deepEqual(actions, []);
});

test('a dropped frame (no hand) resets the hold timer', () => {
  const frames = [
    ...hold(GESTURE.ClosedFist, 0, 400),
    { t: 467, gesture: null, score: 0 },
    ...hold(GESTURE.ClosedFist, 534, 400),
  ];
  const { actions } = run(frames);
  assert.deepEqual(actions, []);
});

test('releasing and re-holding fires again, but only after cooldown', () => {
  // Fire at ~600ms, release, then re-hold so the second fire would land at ~1100ms,
  // which is inside the 1000ms cooldown measured from the first fire.
  const first = hold(GESTURE.ClosedFist, 0, 700);
  const release = [{ t: 767, gesture: null, score: 0 }];
  const second = hold(GESTURE.ClosedFist, 834, 700);
  const blocked = run([...first, ...release, ...second]);
  assert.deepEqual(blocked.actions, [{ type: 'refresh' }]);

  // Same pattern, but the re-hold completes after the cooldown has passed.
  const second2 = hold(GESTURE.ClosedFist, 1500, 700);
  const allowed = run([...first, ...release, ...second2]);
  assert.deepEqual(allowed.actions, [{ type: 'refresh' }, { type: 'refresh' }]);
});

test('cooldown blocks a different gesture fired right after another', () => {
  const frames = [...hold(GESTURE.ClosedFist, 0, 700), ...hold(GESTURE.PointingUp, 767, 700)];
  const { actions } = run(frames);
  assert.deepEqual(actions, [{ type: 'refresh' }]);
});

test('open palm swipe toward the user right fires view-next', () => {
  // Raw wrist x decreases when the user moves their hand to their own right.
  const { actions } = run(swipe(0.7, 0.4, 0, 300));
  assert.deepEqual(actions, [{ type: 'view-next' }]);
});

test('open palm swipe toward the user left fires view-prev', () => {
  const { actions } = run(swipe(0.3, 0.6, 0, 300));
  assert.deepEqual(actions, [{ type: 'view-prev' }]);
});

test('a swipe smaller than swipeMinDx does nothing', () => {
  const { actions } = run(swipe(0.5, 0.4, 0, 300));
  assert.deepEqual(actions, []);
});

test('a slow drift outside the swipe window does nothing', () => {
  // 0.4 total travel, but spread over 2s, so no 500ms window covers the threshold.
  const { actions } = run(swipe(0.7, 0.3, 0, 2000));
  assert.deepEqual(actions, []);
});

test('a stationary open palm never fires', () => {
  const { actions } = run(swipe(0.5, 0.5, 0, 3000));
  assert.deepEqual(actions, []);
});

test('an open palm with no wrist position does not swipe', () => {
  const frames: GestureFrame[] = hold(GESTURE.OpenPalm, 0, 1000);
  const { actions } = run(frames);
  assert.deepEqual(actions, []);
});

test('repeated swipes are throttled by cooldown', () => {
  const frames = [...swipe(0.7, 0.4, 0, 300), ...swipe(0.4, 0.7, 400, 300)];
  const { actions } = run(frames);
  // Second swipe completes at ~700ms, inside the 1000ms cooldown from the first.
  assert.deepEqual(actions, [{ type: 'view-next' }]);
});

test('state carries lastFiredAt so a caller can see the cooldown', () => {
  // Frames land every 67ms, so the first frame at or past holdMs (600) is t=603.
  const { state } = run(hold(GESTURE.ClosedFist, 0, 700));
  assert.equal(state.lastFiredAt, 603);
});
