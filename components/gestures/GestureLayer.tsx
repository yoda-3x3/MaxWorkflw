'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { GestureActionHandler } from './actions';
import { useGestures } from './useGestures';

export const GESTURE_HINT_STORAGE_KEY = 'wdash.gestureHintSeen';
export const GESTURE_HINT_MS = 6000;
export const GESTURE_HINT_TEXT =
  'Swipe to change view · swipe from the left edge for sidebar · pull down to refresh · ' +
  'long-press an agent for details · double-tap empty space for fullscreen · [ sidebar · ← → views · r refresh';

export interface GestureLayerProps {
  // Same handler type as HandCamToggle: every gesture and key emits a GestureAction.
  onAction: GestureActionHandler;
  enabled?: boolean;
  // Show the one-time hint toast on first use. Defaults to true.
  hint?: boolean;
  children?: ReactNode;
}

function hintAlreadySeen(): boolean {
  try {
    return window.localStorage.getItem(GESTURE_HINT_STORAGE_KEY) === '1';
  } catch {
    // Storage can be blocked on locked-down school machines. Then show nothing rather than on every load.
    return true;
  }
}

function markHintSeen(): void {
  try {
    window.localStorage.setItem(GESTURE_HINT_STORAGE_KEY, '1');
  } catch {
    // Ignored: worst case the hint shows again next load.
  }
}

export function GestureLayer({ onAction, enabled = true, hint = true, children }: GestureLayerProps) {
  useGestures(onAction, { enabled });
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (!hint || hintAlreadySeen()) return;
    markHintSeen();
    setShowHint(true);
    const timer = setTimeout(() => setShowHint(false), GESTURE_HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  return (
    // pan-y leaves vertical scrolling to the browser and keeps horizontal swipes for us.
    <div data-gesture-layer="" style={{ touchAction: 'pan-y pinch-zoom' }}>
      {children}
      {showHint && (
        <div
          role="status"
          data-no-gesture=""
          onClick={() => setShowHint(false)}
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 16,
            transform: 'translateX(-50%)',
            maxWidth: 'min(92vw, 420px)',
            padding: '10px 14px',
            borderRadius: 10,
            background: 'rgba(17, 24, 39, 0.95)',
            color: '#e5e7eb',
            fontSize: 13,
            lineHeight: 1.4,
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.4)',
            zIndex: 1000,
            cursor: 'pointer',
          }}
        >
          {GESTURE_HINT_TEXT}
        </div>
      )}
    </div>
  );
}
