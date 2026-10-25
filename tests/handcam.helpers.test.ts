import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wristX } from '../components/handcam/landmarks';
import { cameraErrorMessage, CAMERA_UNSUPPORTED_MESSAGE } from '../components/handcam/errors';

test('wristX reads landmark 0 from a mocked hand', () => {
  const hand = [
    { x: 0.42, y: 0.8, z: 0 },
    { x: 0.5, y: 0.6 },
  ];
  assert.equal(wristX(hand), 0.42);
});

test('wristX is undefined when no hand is visible', () => {
  assert.equal(wristX(undefined), undefined);
  assert.equal(wristX(null), undefined);
  assert.equal(wristX([]), undefined);
});

test('wristX ignores a non-finite coordinate', () => {
  assert.equal(wristX([{ x: Number.NaN, y: 0 }]), undefined);
});

test('camera permission errors map to a blocked/denied message', () => {
  for (const name of ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']) {
    assert.match(cameraErrorMessage({ name }), /blocked or denied/);
  }
});

test('missing camera maps to a no-camera message', () => {
  assert.equal(cameraErrorMessage({ name: 'NotFoundError' }), 'No camera was found on this device.');
});

test('busy camera maps to a busy/blocked message', () => {
  assert.match(cameraErrorMessage({ name: 'NotReadableError' }), /busy or blocked/);
});

test('unknown errors map to a generic message without leaking details', () => {
  const msg = cameraErrorMessage(new Error('internal stack detail xyz'));
  assert.equal(msg, 'Could not start the camera. Hand control is off.');
  assert.equal(cameraErrorMessage(null), 'Could not start the camera. Hand control is off.');
});

test('unsupported-browser message is exported for the no-mediaDevices path', () => {
  assert.match(CAMERA_UNSUPPORTED_MESSAGE, /can't access a camera/);
});
