import { NextResponse, type NextRequest } from 'next/server';
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  appOrigin,
  cookieOptions,
  createOAuthState,
  githubCallbackUrl,
  nowSeconds,
} from '../../../../lib/auth';

// Starts GitHub OAuth. The signed state is also stored in a short-lived cookie,
// and the callback checks that both match. The callback URL is built from APP_ORIGIN.
export async function GET(req: NextRequest) {
  const env = process.env;
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'github_not_configured' }, { status: 500 });
  }

  const state = await createOAuthState(env.SESSION_SECRET, nowSeconds());
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', githubCallbackUrl(appOrigin(req.url, env)));
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'false');

  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, state, cookieOptions(OAUTH_STATE_TTL_SECONDS));
  return res;
}
