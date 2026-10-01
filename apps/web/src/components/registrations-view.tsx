'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiErrorMessage, apiFetch } from '../lib/api-client';
import { bindAlertUser, stopSound } from '../lib/sounds';

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
  exhibitors: Array<{ id: string; name: string; email: string; status: string; role: string }>;
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

  const load = useCallback(async () => {
    const [registrations, people] = await Promise.all([
      apiFetch('/api/management/registrations', { cache: 'no-store' }),
      apiFetch('/api/workforce', { cache: 'no-store' }),
    ]);
    if (!registrations.ok) {
      setError(await apiErrorMessage(registrations, 'Registrations could not be loaded'));
      return;
    }
    setRows(await registrations.json());
    if (people.ok) setWorkforce(await people.json());
    setError('');
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function logout() {
    stopSound();
    bindAlertUser('');
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
              {!row.archivedAt && (
                <div className="drawer-actions">
                  <button type="button" onClick={() => { setEditingId(editingId === row.id ? null : row.id); setTransferId(null); setArchiveId(null); }}>Edit</button>
                  <button type="button" onClick={() => { setTransferId(transferId === row.id ? null : row.id); setEditingId(null); setArchiveId(null); }}>Transfer exhibitor</button>
                  <button type="button" className="critical-button" onClick={() => { setArchiveId(archiveId === row.id ? null : row.id); setEditingId(null); setTransferId(null); }}>Archive</button>
                </div>
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
          <div className="section-title"><div><h2 id="exhibitor-accounts">Exhibitor accounts</h2><p>Stall logins bound to a registration. Transfer and archive revoke those sessions.</p></div></div>
          {rows.some((row) => row.exhibitors.length) ? rows.flatMap((row) => row.exhibitors.map((user) => (
            <article key={user.id + row.id}>
              <div><strong>{user.name}</strong><span>{user.email}</span></div>
              <div><span>Stall</span><strong>{row.stallCode}</strong></div>
              <div><span>Account</span><strong>{user.status}</strong></div>
            </article>
          ))) : <p className="empty-state">No exhibitor accounts are bound to these stalls.</p>}
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
