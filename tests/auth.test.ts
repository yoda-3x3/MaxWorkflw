import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appOrigin,
  createOAuthState,
  createSession,
  githubCallbackUrl,
  isAllowed,
  isPublicPath,
  parseAllowlist,
  verifyOAuthState,
  verifySession,
} from '../lib/auth';

const SECRET = 'test-secret-'.padEnd(40, 'x');
const OTHER_SECRET = 'other-secret-'.padEnd(40, 'y');
const NOW = 1_800_000_000;
const ALLOWED = 'Bob-GH, carol-gh ,alice@example.com';
const env = { SESSION_SECRET: SECRET, ALLOWED_USERS: ALLOWED };

// Re-encode a token's payload while keeping its original signature, to check that
// the signature covers the payload.
function swapPayload(token: string, payload: object): string {
  const [, sig] = token.split('.');
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

test('allowlist: empty or unset denies everyone', () => {
  for (const raw of [undefined, '', '   ', ' , ,']) {
    assert.equal(isAllowed({ login: 'alice' }, raw), false);
  }
});

test('allowlist: logins match case-insensitively', () => {
  assert.equal(isAllowed({ login: 'bob-gh' }, ALLOWED), true);
  assert.equal(isAllowed({ login: 'BOB-GH' }, ALLOWED), true);
  assert.equal(isAllowed({ login: ' Carol-GH ' }, ALLOWED), true);
});

test('allowlist: unlisted logins are denied, and no login means denied', () => {
  assert.equal(isAllowed({ login: 'mallory' }, ALLOWED), false);
  assert.equal(isAllowed({ login: null }, ALLOWED), false);
  assert.equal(isAllowed({}, ALLOWED), false);
});

test('allowlist: entries containing "@" are skipped, so an email never grants access', () => {
  assert.equal(isAllowed({ login: 'alice@example.com' }, ALLOWED), false);
  assert.equal(isAllowed({ login: 'alice' }, ALLOWED), false);
  assert.equal(isAllowed({ login: 'alice@example.com' }, 'alice@example.com'), false);
});

test('parseAllowlist keeps only GitHub logins, lowercased', () => {
  assert.deepEqual([...parseAllowlist(ALLOWED)].sort(), ['bob-gh', 'carol-gh']);
  assert.deepEqual([...parseAllowlist('a@b.co')], []);
});

test('session: sign then verify returns the owner id and display', async () => {
  const token = await createSession({ method: 'github', login: 'Bob-GH' }, SECRET, NOW);
  const user = await verifySession(token, env, NOW + 1);
  assert.deepEqual(user, { id: 'github:bob-gh', method: 'github', display: 'bob-gh' });
});

test('session: rejected when the login is not on the allowlist', async () => {
  const token = await createSession({ method: 'github', login: 'mallory' }, SECRET, NOW);
  assert.equal(await verifySession(token, env, NOW), null);
});

test('session: rejected when signed with another secret', async () => {
  const token = await createSession({ method: 'github', login: 'bob-gh' }, OTHER_SECRET, NOW);
  assert.equal(await verifySession(token, env, NOW), null);
});

test('session: rejected when the payload is altered', async () => {
  const token = await createSession({ method: 'github', login: 'mallory' }, SECRET, NOW);
  const forged = swapPayload(token, { ...payloadOf(token), login: 'bob-gh' });
  assert.equal(await verifySession(forged, env, NOW), null);
});

test('session: rejected after expiry', async () => {
  const token = await createSession({ method: 'github', login: 'bob-gh' }, SECRET, NOW);
  const exp = payloadOf(token).exp as number;
  assert.ok(await verifySession(token, env, exp - 1));
  assert.equal(await verifySession(token, env, exp), null);
});

test('session: revoked when the user is removed from the allowlist', async () => {
  const token = await createSession({ method: 'github', login: 'bob-gh' }, SECRET, NOW);
  assert.equal(await verifySession(token, { ...env, ALLOWED_USERS: 'carol-gh' }, NOW), null);
});

test('session: an OAuth state token is not accepted as a session', async () => {
  const state = await createOAuthState(SECRET, NOW);
  assert.equal(await verifySession(state, env, NOW), null);
});

test('session: fails closed with a missing or short secret', async () => {
  const token = await createSession({ method: 'github', login: 'bob-gh' }, SECRET, NOW);
  assert.equal(await verifySession(token, { ...env, SESSION_SECRET: undefined }, NOW), null);
  assert.equal(await verifySession(token, { ...env, SESSION_SECRET: 'short' }, NOW), null);
  await assert.rejects(createSession({ method: 'github', login: 'bob-gh' }, 'short', NOW));
  await assert.rejects(createSession({ method: 'github', login: 'bob-gh' }, undefined, NOW));
});

test('session: malformed tokens return null and never throw', async () => {
  for (const junk of [undefined, '', 'nodot', 'a.b.c', '!!!.***', '.', 'e30.']) {
    assert.equal(await verifySession(junk, env, NOW), null);
  }
});

test('oauth state: accepted only when the signed value matches the cookie', async () => {
  const state = await createOAuthState(SECRET, NOW);
  assert.equal(await verifyOAuthState(state, state, SECRET, NOW + 1), true);
  assert.equal(await verifyOAuthState(state, undefined, SECRET, NOW + 1), false);
  assert.equal(await verifyOAuthState(state, '', SECRET, NOW + 1), false);
  assert.equal(await verifyOAuthState(null, state, SECRET, NOW + 1), false);
});

test('oauth state: rejects a different state than the cookie', async () => {
  const a = await createOAuthState(SECRET, NOW);
  const b = await createOAuthState(SECRET, NOW);
  assert.equal(await verifyOAuthState(a, b, SECRET, NOW), false);
});

test('oauth state: rejects forged, wrong-secret and expired states', async () => {
  const forged = 'eyJraW5kIjoib2F1dGhfc3RhdGUifQ.AAAA';
  assert.equal(await verifyOAuthState(forged, forged, SECRET, NOW), false);

  const foreign = await createOAuthState(OTHER_SECRET, NOW);
  assert.equal(await verifyOAuthState(foreign, foreign, SECRET, NOW), false);

  const old = await createOAuthState(SECRET, NOW);
  assert.equal(await verifyOAuthState(old, old, SECRET, NOW + 10 * 60), false);
});

test('isPublicPath: only /login and /api/auth/* are public', () => {
  assert.equal(isPublicPath('/login'), true);
  assert.equal(isPublicPath('/login/'), true);
  assert.equal(isPublicPath('/api/auth/me'), true);
  assert.equal(isPublicPath('/api/auth/github/callback'), true);
  assert.equal(isPublicPath('/'), false);
  assert.equal(isPublicPath('/loginx'), false);
  assert.equal(isPublicPath('/api/authz'), false);
  assert.equal(isPublicPath('/api/runs'), false);
  assert.equal(isPublicPath('/api/cron/kick'), false);
});

test('origin: APP_ORIGIN wins over the request origin, trailing slash ignored', () => {
  const env = { APP_ORIGIN: 'https://wf.example.com/' };
  assert.equal(appOrigin('https://other.workers.dev/api/auth/github', env), 'https://wf.example.com');
  assert.equal(githubCallbackUrl(appOrigin('https://other.workers.dev/x', env)), 'https://wf.example.com/api/auth/github/callback');
});

test('origin: without APP_ORIGIN the request origin is used', () => {
  for (const env of [{}, { APP_ORIGIN: '   ' }]) {
    assert.equal(appOrigin('http://localhost:3000/api/auth/github', env), 'http://localhost:3000');
  }
});
