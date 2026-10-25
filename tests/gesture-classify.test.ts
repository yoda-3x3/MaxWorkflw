import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrack,
  isLongPressCancelled,
  isTap,
  keyToAction,
  nextTapState,
  type PointerTrack,
} from '../components/gestures/classify';

function track(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { ms?: number; maxMove?: number; scrollTop?: number } = {},
): PointerTrack {
  return {
    start: { x: from.x, y: from.y, t: 1000 },
    end: { x: to.x, y: to.y, t: 1000 + (opts.ms ?? 200) },
    maxMove: opts.maxMove ?? Math.hypot(to.x - from.x, to.y - from.y),
    scrollTop: opts.scrollTop ?? 0,
  };
}

test('leftward horizontal swipe is view-next', () => {
  assert.deepEqual(classifyTrack(track({ x: 200, y: 300 }, { x: 80, y: 305 })), { type: 'view-next' });
});

test('rightward horizontal swipe is view-prev', () => {
  assert.deepEqual(classifyTrack(track({ x: 100, y: 300 }, { x: 260, y: 300 })), { type: 'view-prev' });
});

test('swipe below the minimum distance is ignored', () => {
  assert.equal(classifyTrack(track({ x: 200, y: 300 }, { x: 150, y: 300 })), null);
});

test('slow drag is not a swipe', () => {
  assert.equal(classifyTrack(track({ x: 200, y: 300 }, { x: 60, y: 300 }, { ms: 1200 })), null);
});

test('mostly vertical movement never becomes a horizontal swipe', () => {
  // Vertical scroll with a little sideways drift must stay untouched.
  assert.equal(classifyTrack(track({ x: 200, y: 400 }, { x: 150, y: 150 })), null);
});

test('diagonal movement below the axis ratio is ignored', () => {
  // dx=80, dy=70: neither axis dominates by 1.5x.
  assert.equal(classifyTrack(track({ x: 200, y: 300 }, { x: 120, y: 370 })), null);
});

test('horizontal swipe starting at the left edge toggles the sidebar', () => {
  assert.deepEqual(classifyTrack(track({ x: 10, y: 300 }, { x: 150, y: 300 })), { type: 'toggle-sidebar' });
  assert.deepEqual(classifyTrack(track({ x: 20, y: 300 }, { x: 0, y: 300 }, { ms: 150 })), null);
});

test('start just outside the edge zone is a normal swipe', () => {
  assert.deepEqual(classifyTrack(track({ x: 40, y: 300 }, { x: 180, y: 300 })), { type: 'view-prev' });
});

test('pull down at the top refreshes', () => {
  assert.deepEqual(classifyTrack(track({ x: 200, y: 100 }, { x: 205, y: 220 }, { scrollTop: 0 })), {
    type: 'refresh',
  });
});

test('pull down while scrolled is not a refresh', () => {
  assert.equal(classifyTrack(track({ x: 200, y: 100 }, { x: 200, y: 220 }, { scrollTop: 340 })), null);
});

test('short pull down is not a refresh', () => {
  assert.equal(classifyTrack(track({ x: 200, y: 100 }, { x: 200, y: 150 }, { scrollTop: 0 })), null);
});

test('pull up is never a refresh', () => {
  assert.equal(classifyTrack(track({ x: 200, y: 300 }, { x: 200, y: 100 }, { scrollTop: 0 })), null);
});

test('isTap accepts a still, quick press', () => {
  assert.equal(isTap(track({ x: 50, y: 50 }, { x: 52, y: 51 }, { ms: 120, maxMove: 3 })), true);
});

test('isTap rejects movement past the slop', () => {
  assert.equal(isTap(track({ x: 50, y: 50 }, { x: 52, y: 51 }, { ms: 120, maxMove: 40 })), false);
});

test('isTap rejects a press held past the tap window (long press)', () => {
  assert.equal(isTap(track({ x: 50, y: 50 }, { x: 50, y: 50 }, { ms: 600, maxMove: 0 })), false);
});

test('long press is cancelled only by movement past the slop', () => {
  assert.equal(isLongPressCancelled(4), false);
  assert.equal(isLongPressCancelled(11), true);
});

test('two quick taps close together are a double tap', () => {
  const first = nextTapState(null, { x: 100, y: 100, t: 0 });
  assert.equal(first.doubleTap, false);
  const second = nextTapState(first.last, { x: 104, y: 98, t: 250 });
  assert.equal(second.doubleTap, true);
});

test('taps too far apart in time are not a double tap', () => {
  const first = nextTapState(null, { x: 100, y: 100, t: 0 });
  const second = nextTapState(first.last, { x: 100, y: 100, t: 400 });
  assert.equal(second.doubleTap, false);
});

test('taps too far apart in space are not a double tap', () => {
  const first = nextTapState(null, { x: 100, y: 100, t: 0 });
  const second = nextTapState(first.last, { x: 160, y: 100, t: 150 });
  assert.equal(second.doubleTap, false);
});

test('a third quick tap after a double tap starts a new pair', () => {
  const a = nextTapState(null, { x: 100, y: 100, t: 0 });
  const b = nextTapState(a.last, { x: 100, y: 100, t: 100 });
  assert.equal(b.doubleTap, true);
  const c = nextTapState(b.last, { x: 100, y: 100, t: 200 });
  assert.equal(c.doubleTap, false);
  const d = nextTapState(c.last, { x: 100, y: 100, t: 300 });
  assert.equal(d.doubleTap, true);
});

test('keyboard equivalents map to actions', () => {
  assert.deepEqual(keyToAction('ArrowRight'), { type: 'view-next' });
  assert.deepEqual(keyToAction('ArrowLeft'), { type: 'view-prev' });
  assert.deepEqual(keyToAction('['), { type: 'toggle-sidebar' });
  assert.deepEqual(keyToAction('r'), { type: 'refresh' });
  assert.deepEqual(keyToAction('R'), { type: 'refresh' });
  assert.equal(keyToAction('ArrowUp'), null);
  assert.equal(keyToAction('x'), null);
});
