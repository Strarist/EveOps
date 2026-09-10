'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function GovernanceAccessPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
          portal: 'GOVERNANCE',
        }),
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error('Governance credentials were not accepted');
        if (response.status === 429) throw new Error('Too many sign-in attempts. Please wait and try again.');
        if (response.status >= 500) throw new Error('EveOps governance is temporarily unavailable.');
        throw new Error('Governance sign-in request could not be accepted');
      }
      const result = (await response.json()) as { user: { role: string } };
      if (result.user.role !== 'SUPER_ADMIN') throw new Error('This account has no governance access');
      router.replace('/super-admin');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to reach EveOps governance');
      setLoading(false);
    }
  }

  return (
    <main className="login-page governance-login">
      <section className="login-brand">
        <div className="brand-mark">E</div>
        <span>EveOps</span>
        <h1>Organization governance</h1>
        <p>Restricted cross-event administration. Every privileged action is authenticated and audited.</p>
      </section>
      <section className="login-panel" aria-labelledby="governance-sign-in">
        <div className="login-card">
          <span className="eyebrow">Restricted access</span>
          <h2 id="governance-sign-in">Governance sign in</h2>
          <p>Only credentials assigned the SuperAdmin role are accepted here.</p>
          <form onSubmit={login}>
            <label>
              SuperAdmin ID
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required minLength={8} />
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary" type="submit" disabled={loading}>
              {loading ? 'Verifying…' : 'Enter governance workspace'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
