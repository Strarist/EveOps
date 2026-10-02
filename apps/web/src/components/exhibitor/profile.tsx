'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { ExhibitorShell } from './shell';
import { useStallProfile } from './data';

export function ExhibitorProfile() {
  const { profile, error, reload } = useStallProfile();
  const scope = profile?.scopes.find((item) => item.stall);
  const place = scope?.stall
    ? [scope.event.name, scope.hall?.name, 'Zone ' + scope.stall.zone.code, 'Stall ' + scope.stall.stallCode].filter(Boolean).join(' / ')
    : '';
  return (
    <ExhibitorShell>
      <section className="exhibitor-profile" aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile and help</h2>
        {error ? <p className="form-error" role="alert">{error} <button type="button" onClick={() => void reload()}>Try again</button></p> : null}
        {profile ? (
          <dl className="exhibitor-account">
            <div><dt>Name</dt><dd>{profile.name}</dd></div>
            {profile.email ? <div><dt>Email</dt><dd>{profile.email}</dd></div> : null}
            {profile.phone ? <div><dt>Phone</dt><dd>{profile.phone}</dd></div> : null}
            <div><dt>Stall</dt><dd>{place || 'Assigned stall'}</dd></div>
          </dl>
        ) : !error ? <p className="empty-state">Loading your account…</p> : null}
        <PushOptIn />
        <div className="exhibitor-help">
          <h3>How this stall screen works</h3>
          <p>Use Request help to ask for Electrical, House Help, or Hall Manager service. Your stall is already known, so you do not pick a hall or stall again.</p>
          <p>Electrical requests ask for an issue type. NCP and Lighting are the two electrical choices.</p>
          <p>Open a request to see its progress, what you reported, and the activity so far. Home shows only a short preview.</p>
          <p>When the status asks you to check the work, open that request, look at the work, then share the completion code with the assigned worker or hall manager. You do not type the code, and you do not close the request yourself.</p>
          <p>Report a problem from the request when the work is waiting for a code or after it is completed. That report asks a hall manager to review it. It does not by itself reopen the request.</p>
        </div>
      </section>
    </ExhibitorShell>
  );
}

function urlBase64ToBytes(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

function PushOptIn() {
  const [message, setMessage] = useState('Background alerts use this browser’s notification permission.');
  async function enable() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setMessage('This browser does not support background notifications.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setMessage(permission === 'denied' ? 'Notifications are blocked in the browser settings.' : 'Notification permission was not granted.');
      return;
    }
    const config = await apiFetch('/api/notifications/push-config', { credentials: 'include', cache: 'no-store' });
    const body = await config.json() as { configured: boolean; publicKey: string | null };
    if (!config.ok || !body.configured || !body.publicKey) {
      setMessage('Background alerts are not configured on this server yet. You can still follow each request on this screen.');
      return;
    }
    const registration = await navigator.serviceWorker.register('/sw.js');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(body.publicKey),
    });
    const json = subscription.toJSON();
    const saved = await apiFetch('/api/notifications/push-subscription', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth }),
    });
    setMessage(saved.ok ? 'Background alerts are on for this browser.' : 'The subscription could not be saved.');
  }
  return (
    <div className="exhibitor-alerts">
      <h3>Notifications</h3>
      <button type="button" onClick={() => void enable()}>Allow background alerts</button>
      <p>{message}</p>
    </div>
  );
}
