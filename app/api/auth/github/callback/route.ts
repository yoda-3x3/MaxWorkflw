import { NextResponse, type NextRequest } from 'next/server';
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  cookieOptions,
  createSession,
  isAllowed,
  nowSeconds,
  verifyOAuthState,
} from '../../../../../lib/auth';

interface GitHubIdentity {
  login: string;
  verifiedEmails: string[];
}

// Exchanges the code and fetches the user plus verified emails. Returns null on any upstream failure.
async function fetchGitHubIdentity(code: string, redirectUri: string): Promise<GitHubIdentity | null> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) return null;
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
  if (!accessToken) return null;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'maxworkflw',
  };
  const signal = AbortSignal.timeout(10_000);
  const [userRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers, signal }),
    fetch('https://api.github.com/user/emails', { headers, signal }),
  ]);
  if (!userRes.ok) return null;
  const user = (await userRes.json()) as { login: string };

  let verifiedEmails: string[] = [];
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as Array<{ email: string; verified: boolean }>;
    verifiedEmails = emails.filter((e) => e.verified).map((e) => e.email);
  }
  return { login: user.login, verifiedEmails };
}

export async function GET(req: NextRequest) {
  const env = process.env;
  const url = req.nextUrl;

  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${error}`, req.url));
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  };

  const stateOk = await verifyOAuthState(
    url.searchParams.get('state'),
    req.cookies.get(OAUTH_STATE_COOKIE)?.value,
    env.SESSION_SECRET,
  );
  const code = url.searchParams.get('code');
  if (!stateOk || !code) return fail('state');

  const identity = await fetchGitHubIdentity(code, new URL('/api/auth/github/callback', req.url).toString());
  if (!identity) return fail('github');

  const matchedEmail = identity.verifiedEmails.find((email) => isAllowed({ email }, env.ALLOWED_USERS));
  const allowedByLogin = isAllowed({ login: identity.login }, env.ALLOWED_USERS);
  if (!matchedEmail && !allowedByLogin) return fail('denied');

  const session = await createSession(
    { method: 'github', login: identity.login, email: matchedEmail ?? null },
    env.SESSION_SECRET,
    nowSeconds(),
  );
  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.delete(OAUTH_STATE_COOKIE);
  res.cookies.set(SESSION_COOKIE, session, cookieOptions(SESSION_TTL_SECONDS));
  return res;
}
