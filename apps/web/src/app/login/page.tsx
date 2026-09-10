'use client';

import type { Role } from '@eveops/contracts';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

const homeByRole: Record<Role, string> = {
  STALL: '/stall',
  STAFF: '/staff',
  HALL_MANAGER: '/hall-manager',
  ADMIN: '/admin',
  SUPER_ADMIN: '/login',
};

export default function LoginPage() {
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
          portal: 'OPERATIONS',
        }),
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error('Incorrect email or password');
        if (response.status === 429) throw new Error('Too many sign-in attempts. Please wait and try again.');
        if (response.status >= 500) throw new Error('EveOps is temporarily unavailable. Please try again shortly.');
        throw new Error('Sign-in request could not be accepted');
      }
      const result = (await response.json()) as { user: { role: Role } };
      router.replace(homeByRole[result.user.role]);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to reach EveOps');
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="brand-mark">E</div>
        <span>EveOps</span>
        <h1>One accountable service journey, from stall request to verified closure.</h1>
        <p>Live exhibition operations for stalls, service teams, hall managers, and event leadership.</p>
      </section>
      <section className="login-panel" aria-labelledby="sign-in-heading">
        <div className="login-card">
          <span className="eyebrow">Secure access</span>
          <h2 id="sign-in-heading">Sign in to EveOps</h2>
          <p>Your account opens only the workspace and event scope assigned to you.</p>
          <form onSubmit={login}>
            <label>
              Email address
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required minLength={8} />
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary" type="submit" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <small>Use the operational account issued for your assigned event, hall, service, or stall.</small>
        </div>
      </section>
    </main>
  );
}
