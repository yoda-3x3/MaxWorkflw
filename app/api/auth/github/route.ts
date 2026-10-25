import { NextResponse, type NextRequest } from 'next/server';
import { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS, cookieOptions, createOAuthState, nowSeconds } from '../../../../lib/auth';

// Starts GitHub OAuth. The signed state is also stored in a short-lived cookie,
// and the callback checks that both match.
export async function GET(req: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'github_not_configured' }, { status: 500 });
  }

  const state = await createOAuthState(process.env.SESSION_SECRET, nowSeconds());
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', new URL('/api/auth/github/callback', req.url).toString());
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'false');

  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, state, cookieOptions(OAUTH_STATE_TTL_SECONDS));
  return res;
}
