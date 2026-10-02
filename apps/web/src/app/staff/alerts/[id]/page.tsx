'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';

type AlertSummary = {
  id: string;
  payload?: { summary?: string; stallCode?: string; publicNo?: string } | null;
};

export default function StaffAlertPage() {
  const params = useParams<{ id: string }>();
  const [alert, setAlert] = useState<AlertSummary | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void apiFetch('/api/notifications/' + params.id, { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          setMissing(true);
          return;
        }
        setAlert(await response.json() as AlertSummary);
      })
      .catch(() => setMissing(true));
  }, [params.id]);

  return (
    <main className="mobile-shell staff">
      <a className="back" href="/staff">← Back to tasks</a>
      <h1>Team alert</h1>
      {missing ? <p className="empty-state">This alert is no longer available.</p> : alert ? (
        <section className="task-alert">
          <strong>{alert.payload?.summary || 'Update'}</strong>
          {alert.payload?.publicNo ? <p>{alert.payload.publicNo}</p> : null}
          <p className="otp-hint">This is a team update. It is not assigned to you, and it does not ask you to accept the task.</p>
        </section>
      ) : <p className="empty-state">Loading alert…</p>}
    </main>
  );
}
