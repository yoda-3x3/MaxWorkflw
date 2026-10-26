import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, appOrigin } from '../../../../lib/auth';

export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL('/login', appOrigin(req.url, process.env)), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
