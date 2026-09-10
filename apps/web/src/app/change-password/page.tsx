'use client';

import type { Role } from '@eveops/contracts';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiErrorMessage, apiFetch } from '../../lib/api-client';

const homeByRole: Record<Role, string> = {
  STALL: '/stall',
  STAFF: '/staff',
  HALL_MANAGER: '/hall-manager',
  ADMIN: '/admin',
  SUPER_ADMIN: '/super-admin',
};

export default function ChangePasswordPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get('currentPassword') ?? '');
    const newPassword = String(form.get('newPassword') ?? '');
    const confirmPassword = String(form.get('confirmPassword') ?? '');
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation must match');
      setLoading(false);
      return;
    }
    try {
      const response = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) {
        setError(await apiErrorMessage(response, 'Password could not be changed'));
        setLoading(false);
        return;
      }
      const me = await apiFetch('/api/auth/me', { cache: 'no-store' });
      if (!me.ok) {
        router.replace('/login');
        return;
      }
      const scope = (await me.json()) as { role: Role };
      router.replace(homeByRole[scope.role] ?? '/login');
      router.refresh();
    } catch {
      setError('Unable to reach EveOps');
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="brand-mark">E</div>
        <span>EveOps</span>
        <h1>Update your temporary password before entering operations.</h1>
        <p>Accounts created by Admin or Hall Manager require a personal password on first sign-in.</p>
      </section>
      <section className="login-panel" aria-labelledby="change-password-heading">
        <div className="login-card">
          <span className="eyebrow">Security</span>
          <h2 id="change-password-heading">Change password</h2>
          <p>Choose a password with at least 10 characters, including a letter and a number.</p>
          <form onSubmit={(event) => void submit(event)}>
            <label>
              Current / temporary password
              <input name="currentPassword" type="password" autoComplete="current-password" required minLength={8} />
            </label>
            <label>
              New password
              <input name="newPassword" type="password" autoComplete="new-password" required minLength={10} />
            </label>
            <label>
              Confirm new password
              <input name="confirmPassword" type="password" autoComplete="new-password" required minLength={10} />
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary" type="submit" disabled={loading}>
              {loading ? 'Saving…' : 'Save and continue'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
