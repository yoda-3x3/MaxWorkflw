import { NextResponse, type NextRequest } from 'next/server';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  cookieOptions,
  createSession,
  nowSeconds,
  verifyMagicToken,
} from '../../../../../lib/auth';

export async function GET(req: NextRequest) {
  const env = process.env;
  const email = await verifyMagicToken(req.nextUrl.searchParams.get('token') ?? undefined, env, nowSeconds());
  if (!email) {
    return NextResponse.redirect(new URL('/login?error=link', req.url));
  }

  const session = await createSession({ method: 'magic_link', email }, env.SESSION_SECRET, nowSeconds());
  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set(SESSION_COOKIE, session, cookieOptions(SESSION_TTL_SECONDS));
  return res;
}
