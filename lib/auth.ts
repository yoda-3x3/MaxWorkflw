// Stateless auth primitives. Web Crypto only, so this runs in middleware (edge)
// and in Node route handlers alike. No new dependencies.
//
// Tokens are `base64url(JSON payload).base64url(HMAC-SHA256)`. Every token carries
// a `kind` so a session cookie can never be replayed as a magic link or OAuth state.

import type { AuthMethod, SessionUser } from './types';

export const SESSION_COOKIE = 'mw_session';
export const OAUTH_STATE_COOKIE = 'mw_oauth_state';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
export const MAGIC_TTL_SECONDS = 60 * 15;
export const OAUTH_STATE_TTL_SECONDS = 60 * 10;

const MIN_SECRET_LENGTH = 32;

// Index signature so process.env (ProcessEnv) is assignable here.
export interface AuthEnv {
  [key: string]: string | undefined;
  SESSION_SECRET?: string;
  ALLOWED_USERS?: string;
  CRON_SECRET?: string;
}

interface SessionPayload extends Signed {
  kind: 'session';
  method: AuthMethod;
  login: string | null;
  email: string | null;
  iat: number;
}

interface Signed {
  kind: string;
  exp: number;
}

interface MagicPayload extends Signed {
  kind: 'magic';
  email: string;
  iat: number;
}

interface StatePayload extends Signed {
  kind: 'oauth_state';
  nonce: string;
  iat: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hasUsableSecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function signToken<T extends Signed>(payload: T, secret: string | undefined): Promise<string> {
  if (!hasUsableSecret(secret)) {
    throw new Error(`SESSION_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`);
  }
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

// Fails closed: any malformed, unsigned, wrong-kind, expired or unusable-secret token gives null.
async function verifyToken<T extends Signed>(
  token: string | undefined,
  secret: string | undefined,
  kind: T['kind'],
  now: number,
): Promise<T | null> {
  if (!token || !hasUsableSecret(secret)) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sigPart] = parts;
  try {
    const key = await hmacKey(secret, 'verify');
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sigPart), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(body))) as T;
    if (payload.kind !== kind || typeof payload.exp !== 'number' || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function normalize(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

// ALLOWED_USERS is a comma-separated list. Entries containing "@" are emails, the rest
// are GitHub logins. Matching is case-insensitive. An empty or unset list denies everyone.
export function parseAllowlist(raw: string | undefined): { emails: Set<string>; logins: Set<string> } {
  const emails = new Set<string>();
  const logins = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const v = normalize(entry);
    if (!v) continue;
    (v.includes('@') ? emails : logins).add(v);
  }
  return { emails, logins };
}

export function isAllowed(
  identity: { email?: string | null; login?: string | null },
  raw: string | undefined,
): boolean {
  const { emails, logins } = parseAllowlist(raw);
  const email = normalize(identity.email);
  const login = normalize(identity.login);
  return Boolean((email && emails.has(email)) || (login && logins.has(login)));
}

export function isPlausibleEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// Paths that must be reachable without a session.
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname === '/api/auth' ||
    pathname.startsWith('/api/auth/')
  );
}

// Owner id is the key runs are stored under (Run.ownerId). It is derived from the
// identity the user signed in with, so a GitHub login and an email are different owners.
function ownerId(method: AuthMethod, login: string | null, email: string | null): string {
  return method === 'github' ? `github:${login}` : `email:${email}`;
}

// Server-to-server calls (Vercel cron, the step self-call) carry no cookie. They may pass
// middleware only on the exact internal paths and only with the exact CRON_SECRET bearer.
// The route handlers still check the secret themselves.
export function isCronAuthorized(
  pathname: string,
  authorization: string | null | undefined,
  env: AuthEnv,
): boolean {
  const internal = pathname === '/api/cron' || pathname.startsWith('/api/cron/') || /^\/api\/runs\/[^/]+\/step$/.test(pathname);
  if (!internal || !env.CRON_SECRET || !authorization) return false;
  const expected = enc.encode(`Bearer ${env.CRON_SECRET}`);
  const actual = enc.encode(authorization);
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  return diff === 0;
}

export async function createSession(
  input: { method: AuthMethod; login?: string | null; email?: string | null },
  secret: string | undefined,
  now: number = nowSeconds(),
): Promise<string> {
  const payload: SessionPayload = {
    kind: 'session',
    method: input.method,
    login: normalize(input.login),
    email: normalize(input.email),
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  return signToken(payload, secret);
}

// Returns the signed-in user only if the signature and expiry are valid AND the identity
// is still on the allowlist, so removing someone from ALLOWED_USERS revokes them at once.
export async function verifySession(
  token: string | undefined,
  env: AuthEnv = process.env,
  now: number = nowSeconds(),
): Promise<SessionUser | null> {
  const payload = await verifyToken<SessionPayload>(token, env.SESSION_SECRET, 'session', now);
  if (!payload) return null;
  if (!isAllowed({ email: payload.email, login: payload.login }, env.ALLOWED_USERS)) return null;
  const display = payload.method === 'github' ? payload.login : payload.email;
  if (!display) return null;
  return {
    id: ownerId(payload.method, payload.login, payload.email),
    method: payload.method,
    display,
  };
}

export async function createMagicToken(
  email: string,
  secret: string | undefined,
  now: number = nowSeconds(),
): Promise<string> {
  const payload: MagicPayload = {
    kind: 'magic',
    email: normalize(email) ?? '',
    iat: now,
    exp: now + MAGIC_TTL_SECONDS,
  };
  return signToken(payload, secret);
}

// Returns the email only if the token is valid and the address is still allowed.
export async function verifyMagicToken(
  token: string | undefined,
  env: AuthEnv,
  now: number = nowSeconds(),
): Promise<string | null> {
  const payload = await verifyToken<MagicPayload>(token, env.SESSION_SECRET, 'magic', now);
  if (!payload || !isAllowed({ email: payload.email }, env.ALLOWED_USERS)) return null;
  return payload.email;
}

// OAuth state is a signed nonce, and the same value must also come back in a
// short-lived cookie set on the way out. That ties the callback to this browser.
export async function createOAuthState(secret: string | undefined, now: number = nowSeconds()): Promise<string> {
  const payload: StatePayload = {
    kind: 'oauth_state',
    nonce: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    iat: now,
    exp: now + OAUTH_STATE_TTL_SECONDS,
  };
  return signToken(payload, secret);
}

export async function verifyOAuthState(
  state: string | null | undefined,
  cookie: string | null | undefined,
  secret: string | undefined,
  now: number = nowSeconds(),
): Promise<boolean> {
  if (!state || !cookie || state !== cookie) return false;
  return (await verifyToken<StatePayload>(state, secret, 'oauth_state', now)) !== null;
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}
