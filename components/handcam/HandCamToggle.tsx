'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GestureRecognizer } from '@mediapipe/tasks-vision';
import { CAMERA_UNSUPPORTED_MESSAGE, MODEL_LOAD_ERROR_MESSAGE, cameraErrorMessage } from './errors';
import { initialEngineState, stepGestureEngine, type EngineState, type GestureFrame } from './gestureEngine';
import { wristX } from './landmarks';
import type { GestureAction, GestureActionHandler } from './types';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const TARGET_FPS = 15;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

type Phase = 'off' | 'starting' | 'on' | 'error';

const ACTION_LABELS: Record<GestureAction['type'], string> = {
  'view-next': 'Next view',
  'view-prev': 'Previous view',
  refresh: 'Refresh',
  'toggle-sidebar': 'Toggle sidebar',
  'open-detail': 'Open agent',
  'toggle-fullscreen': 'Toggle fullscreen',
};

const GESTURE_HELP = [
  ['Open palm, swipe left or right', 'Previous or next view'],
  ['Closed fist, hold', 'Refresh'],
  ['Pointing up, hold', 'Toggle sidebar'],
  ['Thumb up, hold on an agent card', 'Open agent detail'],
] as const;

// Loads MediaPipe only when hand control is turned on, so the wasm and model
// are never fetched for visitors who leave it off.
async function loadRecognizer(): Promise<GestureRecognizer> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 1,
  });
  try {
    return await vision.GestureRecognizer.createFromOptions(fileset, options('GPU'));
  } catch {
    // Some devices have no usable WebGL; retry on CPU before giving up.
    return vision.GestureRecognizer.createFromOptions(fileset, options('CPU'));
  }
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export interface HandCamToggleProps {
  onAction: GestureActionHandler;
  // Returns the agent card under the pointer, used by Thumb_Up.
  getHoveredAgentId?: () => string | null;
}

export default function HandCamToggle({ onAction, getHoveredAgentId }: HandCamToggleProps) {
  const [phase, setPhase] = useState<Phase>('off');
  const [message, setMessage] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognizerRef = useRef<GestureRecognizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const engineRef = useRef<EngineState>(initialEngineState());
  // Bumped on every start/stop so a slow, stale start cannot re-enable the camera.
  const sessionRef = useRef(0);
  const activeRef = useRef(false);
  const onActionRef = useRef(onAction);
  const hoverRef = useRef(getHoveredAgentId);

  useEffect(() => {
    onActionRef.current = onAction;
    hoverRef.current = getHoveredAgentId;
  }, [onAction, getHoveredAgentId]);

  // Releases camera, model and loop. Safe to call repeatedly; sets no React state.
  const teardown = useCallback(() => {
    sessionRef.current += 1;
    activeRef.current = false;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try {
      recognizerRef.current?.close();
    } catch {
      // Closing a half-initialized recognizer can throw; nothing to release.
    }
    recognizerRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
    engineRef.current = initialEngineState();
  }, []);

  const fail = useCallback(
    (text: string) => {
      teardown();
      setPhase('error');
      setMessage(text);
    },
    [teardown],
  );

  const tick = useCallback(
    (now: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (now - lastTickRef.current < FRAME_INTERVAL_MS) return;
      lastTickRef.current = now;

      const video = videoRef.current;
      const recognizer = recognizerRef.current;
      if (!video || !recognizer || video.readyState < 2) return;

      let frame: GestureFrame;
      try {
        const result = recognizer.recognizeForVideo(video, now);
        const top = result.gestures?.[0]?.[0];
        frame = {
          t: now,
          gesture: top?.categoryName ?? null,
          score: top?.score ?? 0,
          wristX: wristX(result.landmarks?.[0]),
          hoveredAgentId: hoverRef.current?.() ?? null,
        };
      } catch {
        fail(MODEL_LOAD_ERROR_MESSAGE);
        return;
      }

      const step = stepGestureEngine(engineRef.current, frame);
      engineRef.current = step.state;
      for (const action of step.actions) {
        setLastAction(ACTION_LABELS[action.type]);
        try {
          onActionRef.current(action);
        } catch (err) {
          // A failing handler must not kill the camera loop.
          console.error('handcam: action handler threw', err);
        }
      }
    },
    [fail],
  );

  const start = useCallback(async () => {
    teardown();
    const session = sessionRef.current;
    const stale = () => session !== sessionRef.current;
    setPhase('starting');
    setMessage(null);
    setLastAction(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      fail(CAMERA_UNSUPPORTED_MESSAGE);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 320, height: 240 },
        audio: false,
      });
    } catch (err) {
      if (!stale()) fail(cameraErrorMessage(err));
      return;
    }
    if (stale()) {
      stopStream(stream);
      return;
    }
    streamRef.current = stream;

    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      await video.play().catch(() => undefined);
    }
    if (stale()) return;

    let recognizer: GestureRecognizer;
    try {
      recognizer = await loadRecognizer();
    } catch {
      if (!stale()) fail(MODEL_LOAD_ERROR_MESSAGE);
      return;
    }
    if (stale()) {
      recognizer.close();
      return;
    }
    recognizerRef.current = recognizer;

    engineRef.current = initialEngineState();
    lastTickRef.current = 0;
    activeRef.current = true;
    setPhase('on');
    rafRef.current = requestAnimationFrame(tick);
  }, [fail, teardown, tick]);

  const stop = useCallback(() => {
    teardown();
    setPhase('off');
    setMessage(null);
  }, [teardown]);

  // Stop on unmount and whenever the tab is hidden. Camera must not run unseen.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && activeRef.current) {
        teardown();
        setPhase('off');
        setMessage('Paused because the tab was hidden. Turn hand control on to resume.');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      teardown();
    };
  }, [teardown]);

  const isOn = phase === 'on' || phase === 'starting';

  return (
    <div className="handcam">
      <button
        type="button"
        className="handcam__toggle"
        aria-pressed={isOn}
        disabled={phase === 'starting'}
        onClick={() => (isOn ? stop() : void start())}
      >
        {isOn ? 'Hand control: on' : 'Hand control: off'}
      </button>

      <div className="handcam__pill" role="status" aria-live="polite">
        {phase === 'starting' && 'Starting camera…'}
        {phase === 'on' && (lastAction ? `Last gesture: ${lastAction}` : 'Watching for gestures')}
        {phase === 'off' && (message ?? 'Hand control is off')}
        {phase === 'error' && message}
      </div>

      <video
        ref={videoRef}
        className="handcam__preview"
        muted
        playsInline
        aria-label="Camera preview for hand control. Not recorded or uploaded."
        hidden={!isOn}
        style={{ transform: 'scaleX(-1)' }}
        width={160}
        height={120}
      />

      <details className="handcam__privacy">
        <summary>Privacy and gestures</summary>
        <p>
          Hand control runs entirely in your browser. Camera frames are analyzed on this device
          and are never uploaded, stored, or recorded. The gesture model is downloaded once from
          Google's CDN when you first turn hand control on. The camera turns off when you turn
          it off, leave this page, or switch tabs.
        </p>
        <ul>
          {GESTURE_HELP.map(([gesture, effect]) => (
            <li key={gesture}>
              <strong>{gesture}:</strong> {effect}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
