import { after, NextResponse, type NextRequest } from 'next/server';
import { createMagicToken, isAllowed, isPlausibleEmail, nowSeconds } from '../../../../lib/auth';

// Every well-formed request gets the same response, so this never reveals whether an
// address is on the allowlist. The send runs after the response, and only for allowed
// addresses, so timing does not reveal it either.
const GENERIC_OK = {
  ok: true,
  message: 'If that address is allowed to sign in, a sign-in link is on its way.',
};

async function sendMagicLink(email: string, origin: string): Promise<void> {
  const env = process.env;
  const token = await createMagicToken(email, env.SESSION_SECRET, nowSeconds());
  const link = new URL('/api/auth/magic/verify', origin);
  link.searchParams.set('token', token);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [email],
      subject: 'Your MaxWorkflw sign-in link',
      text: `Sign in to MaxWorkflw: ${link.toString()}\n\nThis link expires in 15 minutes. If you did not ask for it, ignore this email.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.error('magic link email failed', res.status);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const raw = typeof body === 'object' && body !== null ? (body as { email?: unknown }).email : undefined;
  if (typeof raw !== 'string' || !isPlausibleEmail(raw)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }

  const email = raw.trim().toLowerCase();
  if (isAllowed({ email }, process.env.ALLOWED_USERS)) {
    const origin = req.nextUrl.origin;
    after(() => sendMagicLink(email, origin));
  }
  return NextResponse.json(GENERIC_OK);
}
