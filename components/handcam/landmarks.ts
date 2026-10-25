export interface LandmarkLike {
  x: number;
  y: number;
  z?: number;
}

// Landmark 0 is the wrist in MediaPipe's hand model.
export function wristX(hand: readonly LandmarkLike[] | null | undefined): number | undefined {
  const wrist = hand?.[0];
  return wrist && Number.isFinite(wrist.x) ? wrist.x : undefined;
}
