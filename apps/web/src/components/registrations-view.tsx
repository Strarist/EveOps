'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiErrorMessage, apiFetch } from '../lib/api-client';
import { releaseWorkAlerts } from '../lib/work-alerts';

type ServicePriority = 'HIGH' | 'MEDIUM' | 'LOW';

type Registration = {
  id: string;
  stallCode: string;
  exhibitorName: string;
  contact: string | null;
  servicePriority: ServicePriority;
  active: boolean;
  archivedAt: string | null;
  openTicketCount: number;
  zone: { id: string; code: string; hall: { id: string; code: string; name: string } };
  exhibitors: Array<{ id: string; name: string; email: string; status: string; role: string; mustChangePassword?: boolean }>;
};

type ZoneOption = { id: string; eventId: string; label: string };

type LoginHandoff = {
  loginPath: string;
  email: string;
  initialCredential: string | null;
  stallCode: string;
  instructions: string;
};

type WorkforceRow = {
  user: { id: string; name: string; email?: string; role?: string; status?: string; employeeCode?: string | null };
  pool: { category: string; subtype: string };
};

export function RegistrationsView() {
  const router = useRouter();
  const [rows, setRows] = useState<Registration[]>([]);
  const [workforce, setWorkforce] = useState<WorkforceRow[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [handoff, setHandoff] = useState<LoginHandoff | null>(null);
  const [loginStallId, setLoginStallId] = useState<string | null>(null);
  const registrationKey = useRef('');
  if (!registrationKey.current) registrationKey.current = crypto.randomUUID();

  const load = useCallback(async () => {
    const [registrations, people, masters] = await Promise.all([
      apiFetch('/api/management/registrations', { cache: 'no-store' }),
      apiFetch('/api/workforce', { cache: 'no-store' }),
      apiFetch('/api/management/masters', { cache: 'no-store' }),
    ]);
    if (!registrations.ok) {
      setError(await apiErrorMessage(registrations, 'Registrations could not be loaded'));
      return;
    }
    setRows(await registrations.json());
    if (people.ok) setWorkforce(await people.json());
    if (masters.ok) {
      const events = await masters.json() as Array<{ id: string; name: string; halls: Array<{ name: string; zones: Array<{ id: string; code: string }> }> }>;
      setZones(events.flatMap((event) => event.halls.flatMap((hall) => hall.zones.map((zone) => ({
        id: zone.id,
        eventId: event.id,
        label: `${event.name} · ${hall.name} · Zone ${zone.code}`,
      })))));
    }
    setError('');
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function logout() {
    releaseWorkAlerts();
    await globalThis.fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.replace('/login');
    router.refresh();
  }

  async function submit(event: FormEvent<HTMLFormElement>, path: string, method: 'PATCH' | 'POST') {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice('');
    setError('');
    const values = new FormData(event.currentTarget);
    const body: Record<string, string> = {};
    for (const [key, value] of values.entries()) {
      if (typeof value === 'string' && value.trim()) body[key] = value.trim();
    }
    const response = await apiFetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      setError(await apiErrorMessage(response, 'Registration could not be updated'));
      return;
    }
    setEditingId(null);
    setTransferId(null);
    setArchiveId(null);
    setNotice('Registration updated. Ticket history stays on the original stall.');
    await load();
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>, path: string) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice('');
    setError('');
    const values = new FormData(event.currentTarget);
    const zone = zones.find((item) => item.id === String(values.get('zoneId') ?? ''));
    const body: Record<string, string> = { idempotencyKey: registrationKey.current };
    for (const [key, value] of values.entries()) {
      if (typeof value === 'string' && value.trim()) body[key] = value.trim();
    }
    if (zone) body.eventId = zone.eventId;
    const response = await apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!response.ok) {
      setError(await apiErrorMessage(response, 'Exhibitor login could not be created'));
      return;
    }
    const result = await response.json() as { handoff?: LoginHandoff; credentialIssued?: boolean };
    registrationKey.current = crypto.randomUUID();
    setHandoff(result.handoff ?? null);
    setLoginStallId(null);
    event.currentTarget.reset();
    setNotice(result.credentialIssued ? 'Exhibitor login is ready. Copy the instructions before leaving this page.' : 'This login already exists. Reset the initial password if you still need one.');
    await load();
  }

  async function resetLogin(stallId: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const response = await apiFetch('/api/management/registrations/' + stallId + '/exhibitor-login/reset', { method: 'POST' });
    setBusy(false);
    if (!response.ok) {
      setError(await apiErrorMessage(response, 'Initial password could not be reset'));
      return;
    }
    const result = await response.json() as { handoff?: LoginHandoff };
    setHandoff(result.handoff ?? null);
    setNotice('A new initial password is ready. Earlier sessions for this account are signed out.');
    await load();
  }

  const staff = workforce.filter((row) => row.user.role === 'STAFF');
  const managers = workforce.filter((row) => row.user.role === 'HALL_MANAGER');
  const activeRows = rows.filter((row) => !row.archivedAt);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>E</span>EveOps</div>
        <nav aria-label="Admin registration navigation">
          <Link href="/admin">Command center</Link>
          <Link href="/admin/registrations" aria-current="page">Registrations</Link>
        </nav>
        <button className="logout" type="button" onClick={() => void logout()}>Sign out</button>
      </aside>
      <main className="management">
        <header className="topbar">
          <div>
            <span className="eyebrow">Admin</span>
            <h1>Registrations</h1>
          </div>
        </header>
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="alert-line" role="status">{notice}</p>}
        {handoff && <CredentialHandoff handoff={handoff} onDismiss={() => setHandoff(null)} />}

        <section className="portfolio-list" aria-labelledby="new-registration">
          <div className="section-title">
            <div>
              <h2 id="new-registration">Register a stall and login</h2>
              <p>Create the stall and the exhibitor account together. The initial password is shown once on this page.</p>
            </div>
          </div>
          <form className="authority-action registration-create" onSubmit={(event) => void submitLogin(event, '/api/management/registrations/with-login')}>
            <label>Zone<span aria-hidden="true"> *</span>
              <select name="zoneId" required defaultValue="">
                <option value="" disabled>Choose a zone</option>
                {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
              </select>
            </label>
            <label>Stall code<span aria-hidden="true"> *</span><input name="stallCode" required minLength={1} /></label>
            <label>Exhibitor<span aria-hidden="true"> *</span><input name="exhibitorName" required minLength={1} /></label>
            <label>Contact<input name="contact" /></label>
            <label>Service priority
              <select name="servicePriority" defaultValue="MEDIUM">
                <option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option>
                <option value="LOW">Low</option>
              </select>
            </label>
            <label>Login name<span aria-hidden="true"> *</span><input name="loginName" required minLength={2} /></label>
            <label>Login email<span aria-hidden="true"> *</span><input name="loginEmail" type="email" required autoComplete="off" /></label>
            <button className="primary" type="submit" disabled={busy || !zones.length}>{busy ? 'Creating…' : 'Create stall and exhibitor login'}</button>
          </form>
        </section>

        <section className="portfolio-list" aria-labelledby="stall-registrations">
          <div className="section-title">
            <div>
              <h2 id="stall-registrations">Stall registrations</h2>
              <p>Edit the exhibitor record and service priority. Transfer and archive stay blocked while tickets are unresolved.</p>
            </div>
          </div>
          {rows.length ? rows.map((row) => (
            <article key={row.id}>
              <div>
                <strong>{row.stallCode} · {row.exhibitorName}</strong>
                <span>{row.zone.hall.name} · Zone {row.zone.code}{row.contact ? ` · ${row.contact}` : ''}</span>
              </div>
              <div><span>Service priority</span><strong>{row.servicePriority}</strong></div>
              <div><span>Open tickets</span><strong>{row.openTicketCount}</strong></div>
              <div><span>Status</span><strong>{row.archivedAt ? 'Archived' : row.active ? 'Active' : 'Inactive'}</strong></div>
              {row.exhibitors.length ? row.exhibitors.map((user) => (
                <div className="login-line" key={user.id}>
                  <span>Login</span>
                  <strong>{user.email}</strong>
                  <span>{user.status}{user.mustChangePassword ? ' · password change required' : ''}</span>
                </div>
              )) : <div className="login-line"><span>Login</span><strong>No exhibitor login yet</strong></div>}
              {!row.archivedAt && (
                <div className="drawer-actions">
                  <button type="button" onClick={() => { setEditingId(editingId === row.id ? null : row.id); setTransferId(null); setArchiveId(null); }}>Edit</button>
                  <button type="button" onClick={() => { setTransferId(transferId === row.id ? null : row.id); setEditingId(null); setArchiveId(null); }}>Transfer exhibitor</button>
                  <button type="button" className="critical-button" onClick={() => { setArchiveId(archiveId === row.id ? null : row.id); setEditingId(null); setTransferId(null); setLoginStallId(null); }}>Archive</button>
                  {row.exhibitors.length
                    ? <button type="button" onClick={() => void resetLogin(row.id)} disabled={busy}>Reset initial password</button>
                    : <button type="button" onClick={() => { setLoginStallId(loginStallId === row.id ? null : row.id); setEditingId(null); setTransferId(null); setArchiveId(null); }}>Create exhibitor login</button>}
                </div>
              )}
              {loginStallId === row.id && !row.exhibitors.length && (
                <form className="authority-action" onSubmit={(event) => void submitLogin(event, '/api/management/registrations/' + row.id + '/exhibitor-login')}>
                  <label>Login name<span aria-hidden="true"> *</span><input name="loginName" required minLength={2} defaultValue={row.exhibitorName} /></label>
                  <label>Login email<span aria-hidden="true"> *</span><input name="loginEmail" type="email" required autoComplete="off" /></label>
                  <div className="drawer-actions">
                    <button type="button" onClick={() => setLoginStallId(null)}>Cancel</button>
                    <button className="primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create exhibitor login'}</button>
                  </div>
                </form>
              )}
              {editingId === row.id && (
                <form className="authority-action" onSubmit={(event) => void submit(event, '/api/management/registrations/' + row.id, 'PATCH')}>
                  <label>Stall code<input name="stallCode" required defaultValue={row.stallCode} /></label>
                  <label>Exhibitor<input name="exhibitorName" required defaultValue={row.exhibitorName} /></label>
                  <label>Contact<input name="contact" defaultValue={row.contact ?? ''} /></label>
                  <label>Service priority
                    <select name="servicePriority" defaultValue={row.servicePriority}>
                      <option value="HIGH">High</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="LOW">Low</option>
                    </select>
                  </label>
                  <div className="drawer-actions">
                    <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                    <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save registration'}</button>
                  </div>
                </form>
              )}
              {transferId === row.id && (
                <form className="authority-action" onSubmit={(event) => void submit(event, '/api/management/registrations/' + row.id + '/transfer', 'POST')}>
                  <label>Destination stall
                    <select name="destinationStallId" required defaultValue="">
                      <option value="" disabled>Choose a stall</option>
                      {activeRows.filter((candidate) => candidate.id !== row.id).map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>{candidate.zone.hall.code} · {candidate.stallCode} · {candidate.exhibitorName}</option>
                      ))}
                    </select>
                  </label>
                  <label>Reason<textarea name="reason" required minLength={3} /></label>
                  <div className="drawer-actions">
                    <button type="button" onClick={() => setTransferId(null)}>Cancel</button>
                    <button className="primary" type="submit" disabled={busy}>{busy ? 'Transferring…' : 'Transfer exhibitor'}</button>
                  </div>
                </form>
              )}
              {archiveId === row.id && (
                <form className="authority-action" onSubmit={(event) => void submit(event, '/api/management/registrations/' + row.id + '/archive', 'POST')}>
                  <label>Reason<textarea name="reason" required minLength={3} /></label>
                  <div className="drawer-actions">
                    <button type="button" onClick={() => setArchiveId(null)}>Cancel</button>
                    <button className="critical-button" type="submit" disabled={busy}>{busy ? 'Archiving…' : 'Archive registration'}</button>
                  </div>
                </form>
              )}
            </article>
          )) : <p className="empty-state">No stall registrations in your event scope.</p>}
        </section>

        <section className="portfolio-list" aria-labelledby="exhibitor-accounts">
          <div className="section-title"><div><h2 id="exhibitor-accounts">Exhibitor accounts</h2><p>Each stall registration above shows its login. Transfer and archive still revoke those sessions.</p></div></div>
        </section>

        <section className="portfolio-list" aria-labelledby="staff-accounts">
          <div className="section-title"><div><h2 id="staff-accounts">Staff</h2><p>Staff accounts stay in Workforce. They are not stall registrations.</p></div><Link href="/admin">Open workforce</Link></div>
          {staff.length ? staff.map((row) => (
            <article key={row.user.id + row.pool.category + row.pool.subtype}>
              <div><strong>{row.user.name}</strong><span>{row.user.employeeCode ?? row.user.email}</span></div>
              <div><span>Service</span><strong>{row.pool.category} · {row.pool.subtype}</strong></div>
              <div><span>Account</span><strong>{row.user.status ?? 'ACTIVE'}</strong></div>
            </article>
          )) : <p className="empty-state">No staff memberships in this scope.</p>}
        </section>

        <section className="portfolio-list" aria-labelledby="manager-accounts">
          <div className="section-title"><div><h2 id="manager-accounts">Hall managers</h2><p>Hall manager accounts stay in Workforce.</p></div><Link href="/admin">Open workforce</Link></div>
          {managers.length ? managers.map((row) => (
            <article key={row.user.id + row.pool.category + row.pool.subtype}>
              <div><strong>{row.user.name}</strong><span>{row.user.employeeCode ?? row.user.email}</span></div>
              <div><span>Service</span><strong>{row.pool.category} · {row.pool.subtype}</strong></div>
              <div><span>Account</span><strong>{row.user.status ?? 'ACTIVE'}</strong></div>
            </article>
          )) : <p className="empty-state">No hall manager memberships in this scope.</p>}
        </section>
      </main>
    </div>
  );
}

function CredentialHandoff({ handoff, onDismiss }: { handoff: LoginHandoff; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const loginUrl = `${window.location.origin}${handoff.loginPath}`;
  const text = [
    `Login URL: ${loginUrl}`,
    `Login ID: ${handoff.email}`,
    handoff.initialCredential ? `Initial password: ${handoff.initialCredential}` : 'Initial password: shown only when it is created or reset',
    `Stall: ${handoff.stallCode}`,
    handoff.instructions,
  ].join('\n');
  return (
    <section className="credential-handoff" role="status" aria-label="Exhibitor login instructions">
      <h2>Exhibitor login</h2>
      <p>{handoff.instructions}</p>
      <dl>
        <div><dt>Login URL</dt><dd>{loginUrl}</dd></div>
        <div><dt>Login ID</dt><dd>{handoff.email}</dd></div>
        <div><dt>Initial password</dt><dd>{handoff.initialCredential ?? 'Not shown again'}</dd></div>
        <div><dt>Stall</dt><dd>{handoff.stallCode}</dd></div>
      </dl>
      <p>First sign-in asks for a new password. This password is not stored in the registration list.</p>
      <div className="drawer-actions">
        <button type="button" className="primary" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy login instructions'}</button>
        <button type="button" onClick={onDismiss}>Dismiss</button>
      </div>
    </section>
  );
}
