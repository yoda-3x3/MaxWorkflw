export const CAMERA_UNSUPPORTED_MESSAGE =
  "This browser can't access a camera, so hand control is unavailable.";

export const MODEL_LOAD_ERROR_MESSAGE =
  'The gesture model could not load. Check your connection and try again.';

// Maps a getUserMedia / camera failure to a short, friendly message. Never
// includes raw error text, so nothing internal leaks into the UI.
export function cameraErrorMessage(err: unknown): string {
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera access is blocked or denied. Allow the camera for this site, or ask your admin if the school blocks it, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'The camera is busy or blocked by another app. Close the other app and try again.';
    default:
      return 'Could not start the camera. Hand control is off.';
  }
}
