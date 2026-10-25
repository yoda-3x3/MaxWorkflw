import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '../../../../lib/auth';

export async function GET(req: NextRequest) {
  const user = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(user, { headers: { 'Cache-Control': 'no-store' } });
}
