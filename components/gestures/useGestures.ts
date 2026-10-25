'use client';

import { useEffect, useRef } from 'react';
import type { GestureAction, GestureActionHandler } from './actions';
import {
  GESTURE_TUNING,
  classifyTrack,
  isLongPressCancelled,
  isTap,
  keyToAction,
  nextTapState,
  type PointerTrack,
  type TapRecord,
} from './classify';

// Anything matching this is left alone: form fields, explicit opt-outs and the ticker.
export const GESTURE_IGNORE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-no-gesture], [data-ticker]';

// Taps on these never count as "empty area" for double-tap fullscreen.
const NOT_EMPTY_SELECTOR =
  '[data-agent-id], button, a, label, summary, [role="button"], [role="tab"], [role="menuitem"]';

interface ActivePointer {
  id: number;
  pointerType: string;
  track: PointerTrack;
  target: Element;
  agentId: string | null;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  longPressFired: boolean;
}

export interface UseGesturesOptions {
  enabled?: boolean;
}

function closestElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function isIgnoredTarget(el: Element): boolean {
  return el.closest(GESTURE_IGNORE_SELECTOR) !== null;
}

// Nearest scrolling ancestor's offset, falling back to the page. Pull-to-refresh only fires at 0.
function scrollTopAt(el: Element): number {
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const scrollable = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    if (scrollable) return node.scrollTop;
    node = node.parentElement;
  }
  return window.scrollY || document.documentElement.scrollTop || 0;
}

// Attaches window-level pointer and keyboard listeners and emits GestureActions.
// Listeners are passive and never call preventDefault, so vertical scrolling is not affected.
export function useGestures(onAction: GestureActionHandler, options: UseGesturesOptions = {}): void {
  const { enabled = true } = options;
  // Latest handler without re-subscribing listeners on every render.
  const handlerRef = useRef(onAction);
  handlerRef.current = onAction;

  useEffect(() => {
    if (!enabled) return;

    const emit = (action: GestureAction) => handlerRef.current(action);
    let active: ActivePointer | null = null;
    let lastTap: TapRecord | null = null;
    let multiTouch = false;

    const clearLongPress = (p: ActivePointer) => {
      if (p.longPressTimer !== null) {
        clearTimeout(p.longPressTimer);
        p.longPressTimer = null;
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (active) {
        // A second finger cancels long-press and turns the gesture into a multi-touch no-op.
        if (!e.isPrimary) {
          multiTouch = true;
          clearLongPress(active);
        }
        return;
      }
      if (e.button !== 0) return;

      const target = closestElement(e.target);
      if (!target || isIgnoredTarget(target)) return;

      multiTouch = false;
      const agentEl = target.closest('[data-agent-id]');
      const agentId = agentEl?.getAttribute('data-agent-id') ?? null;
      const pointer: ActivePointer = {
        id: e.pointerId,
        pointerType: e.pointerType,
        track: {
          start: { x: e.clientX, y: e.clientY, t: e.timeStamp },
          end: { x: e.clientX, y: e.clientY, t: e.timeStamp },
          maxMove: 0,
          scrollTop: scrollTopAt(target),
        },
        target,
        agentId,
        longPressTimer: null,
        longPressFired: false,
      };
      if (agentId !== null) {
        pointer.longPressTimer = setTimeout(() => {
          pointer.longPressTimer = null;
          if (active !== pointer || multiTouch) return;
          pointer.longPressFired = true;
          emit({ type: 'open-detail', agentId });
        }, GESTURE_TUNING.LONG_PRESS_MS);
      }
      active = pointer;
    };

    const onPointerMove = (e: PointerEvent) => {
      const p = active;
      if (!p || e.pointerId !== p.id) return;
      const { start } = p.track;
      p.track.end = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      const move = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      p.track.maxMove = Math.max(p.track.maxMove, move);
      if (isLongPressCancelled(p.track.maxMove)) clearLongPress(p);
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      const p = active;
      if (!p || e.pointerId !== p.id) return;
      clearLongPress(p);
      active = null;
      if (cancelled || multiTouch || p.longPressFired) {
        lastTap = null;
        return;
      }

      p.track.end = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (isTap(p.track)) {
        // Double-tap on empty space toggles fullscreen. Taps on agents or controls reset the pair.
        if (p.target.closest(NOT_EMPTY_SELECTOR) !== null) {
          lastTap = null;
          return;
        }
        const tap: TapRecord = { x: e.clientX, y: e.clientY, t: e.timeStamp };
        const result = nextTapState(lastTap, tap);
        lastTap = result.last;
        if (result.doubleTap) emit({ type: 'toggle-fullscreen' });
        return;
      }

      lastTap = null;
      const action = classifyTrack(p.track);
      if (action) emit(action);
    };

    const onPointerUp = (e: PointerEvent) => finish(e, false);
    const onPointerCancel = (e: PointerEvent) => finish(e, true);

    // Long press on touch makes Android Chrome open a context menu, which would cancel the pointer.
    const onContextMenu = (e: Event) => {
      if (active && active.pointerType === 'touch' && (active.longPressFired || active.longPressTimer !== null)) {
        e.preventDefault();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = closestElement(e.target);
      if (target && isIgnoredTarget(target)) return;
      const action = keyToAction(e.key);
      if (action) emit(action);
    };

    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      if (active) clearLongPress(active);
      active = null;
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}
