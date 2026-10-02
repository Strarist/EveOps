'use client';

import { useCallback, useEffect, useState } from 'react';
import { AUTH_LOST_EVENT, apiFetch, subscribeRealtime } from '../lib/api-client';
import {
  acknowledgeAlert,
  bindWorkAlerts,
  currentRinging,
  enableWorkAlerts,
  measureAlertCapability,
  onWorkAlertsChanged,
  releaseWorkAlerts,
  setupCompleted,
  silenceCurrent,
  syncWorkAlerts,
  type WorkAlert,
} from '../lib/work-alerts';

type Notice = {
  id: string;
  type: string;
  sentAt: string;
  readAt: string | null;
  payload?: { summary?: string; href?: string; audience?: string; tone?: string; actionable?: boolean } | null;
};

export function WorkAlertHost({ userId }: { userId: string }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [ringing, setRinging] = useState<WorkAlert | null>(null);
  const [unread, setUnread] = useState<Notice[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    const response = await apiFetch('/api/notifications', { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return;
    const rows = await response.json() as Notice[];
    setUnread(rows.filter((row) => !row.readAt));
    syncWorkAlerts(rows.filter((row) => !row.readAt).map((row) => ({
      id: row.id,
      sentAt: row.sentAt,
      actionable: row.payload?.actionable === true,
      tone: row.payload?.tone === 'assignment' ? 'assignment' : 'operational',
      summary: row.payload?.summary || 'Update',
      href: row.payload?.href || '/staff/alerts/' + row.id,
      audience: row.payload?.audience || 'team',
    })));
    setRinging(currentRinging());
  }, []);

  useEffect(() => {
    bindWorkAlerts(userId);
    setReady(setupCompleted(userId));
    const measured = measureAlertCapability();
    setRecovery(setupCompleted(userId) ? measured.recovery : null);
    const stop = onWorkAlertsChanged(() => setRinging(currentRinging()));
    const onResume = () => {
      if (document.visibilityState !== 'visible' || !setupCompleted(userId)) return;
      setRecovery(measureAlertCapability().recovery);
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener(AUTH_LOST_EVENT, releaseWorkAlerts);
    const unsubscribe = subscribeRealtime({ onTicket: () => { void refresh(); }, onConnection: () => undefined });
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener(AUTH_LOST_EVENT, releaseWorkAlerts);
      unsubscribe();
      window.clearInterval(timer);
      releaseWorkAlerts();
    };
  }, [userId, refresh]);

  async function enable() {
    setBusy(true);
    const result = await enableWorkAlerts(userId);
    setReady(true);
    setRecovery(result.recovery);
    setBusy(false);
    await refresh();
  }

  async function hearAgain() {
    const result = await enableWorkAlerts(userId);
    setRecovery(result.recovery);
  }

  return (
    <div className="work-alerts">
      <div className="work-alert-bar">
        <button type="button" onClick={() => setOpen((value) => !value)}>Alerts · {unread.length}</button>
      </div>
      {!ready && (
        <section className="task-alert" aria-label="Work alert setup">
          <h2>Enable work alerts and continue</h2>
          <p>Get alerts for new work and important updates.</p>
          <button type="button" className="primary" disabled={busy} onClick={() => void enable()}>{busy ? 'Checking…' : 'Enable work alerts and continue'}</button>
        </section>
      )}
      {ready && recovery && (
        <p className="alert-line" role="status">
          {recovery}
          {recovery.startsWith('Tap to hear') && <button type="button" onClick={() => void hearAgain()}>Hear work alerts</button>}
          <details>
            <summary>If alerts stay quiet</summary>
            <p>EveOps cannot raise the device volume. Allow notifications for this site in the browser settings, and keep the app open to hear the work tone. A locked phone may show a notification without repeating the tone.</p>
          </details>
        </p>
      )}
      {ringing && (
        <section className="task-alert" role="status" aria-label="Work alert">
          <strong>{ringing.audience === 'assignment' ? 'Your new task' : ringing.summary}</strong>
          {ringing.audience === 'assignment' ? <p>{ringing.summary}</p> : null}
          <div className="ticket-actions">
            <a className="secondary-action" href={ringing.href} onClick={() => silenceCurrent()}>View</a>
            <button type="button" onClick={() => acknowledgeAlert(ringing.id)}>Acknowledge</button>
          </div>
          <p className="otp-hint">Acknowledging stops the sound. It does not accept, snooze, or close the task.</p>
        </section>
      )}
      {open && (
        <section className="notification-panel" aria-label="Unread alerts">
          {unread.length ? unread.map((row) => (
            <button key={row.id} type="button" onClick={() => acknowledgeAlert(row.id)}>{row.payload?.summary || 'Update'}</button>
          )) : <p className="empty-state">No unread alerts.</p>}
        </section>
      )}
    </div>
  );
}
