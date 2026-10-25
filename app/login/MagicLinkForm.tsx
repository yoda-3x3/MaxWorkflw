'use client';

import { useState, type FormEvent } from 'react';

export default function MagicLinkForm() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/magic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.status === 400) {
        setMessage('Enter a valid email address.');
      } else if (res.ok) {
        setMessage('If that address is allowed to sign in, a sign-in link is on its way. Check your inbox.');
      } else {
        setMessage('Could not send the link. Try again.');
      }
    } catch {
      setMessage('Network error. Try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="login-magic">
      <input
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />
      <button type="submit" disabled={sending}>
        {sending ? 'Sending…' : 'Email me a link'}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
