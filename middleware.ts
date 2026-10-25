import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, isCronAuthorized, isPublicPath, verifySession } from './lib/auth';

// Every page and API route needs a valid session, except /login and /api/auth/*.
// Cron and step self-calls may pass with the exact CRON_SECRET bearer (see isCronAuthorized).
// Static assets are skipped by the matcher.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (isCronAuthorized(pathname, req.headers.get('authorization'), process.env)) return NextResponse.next();

  const user = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (user) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
