const ERROR_MESSAGES: Record<string, string> = {
  denied: "That GitHub account isn't allowed to sign in.",
  state: 'That sign-in attempt expired or was tampered with. Try again.',
  github: 'GitHub sign-in failed. Try again.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error ? (ERROR_MESSAGES[error] ?? 'Sign-in failed.') : null;

  return (
    <main className="login">
      <h1>WorkflwPro</h1>
      {message && <p role="alert" className="login-error">{message}</p>}
      <a className="login-github" href="/api/auth/github">Sign in with GitHub</a>
    </main>
  );
}
