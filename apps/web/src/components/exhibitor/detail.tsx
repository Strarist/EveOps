'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiErrorMessage, apiFetch, AUTH_LOST_EVENT } from '@/lib/api-client';
import { useOperationalNow } from '@/lib/server-clock';
import { ExhibitorShell } from './shell';
import { useConnection, useStallProfile, useStallTicket } from './data';
import { complaintAllowed, countdownLabel, eventTime, progressText, serviceText, stallPlace, type StallTicket } from './format';

export function ExhibitorDetail({ ticketId }: { ticketId: string }) {
  const { connection, pulse } = useConnection();
  const { profile } = useStallProfile(connection + pulse);
  const { ticket, state, error, reload } = useStallTicket(ticketId, pulse);
  const timeZone = ticket?.event?.timezone || profile?.scopes[0]?.event.timezone || 'UTC';
  return (
    <ExhibitorShell>
      <a className="back" href="/stall/requests">Back to my requests</a>
      {state === 'loading' && !ticket ? <p className="empty-state">Loading this request…</p> : null}
      {state === 'error' ? <p className="form-error" role="alert">{error} <button type="button" onClick={() => void reload()}>Try again</button></p> : null}
      {state === 'missing' ? <p className="empty-state" role="status">This request could not be found.</p> : null}
      {state === 'inaccessible' ? <p className="form-error" role="alert">This request is no longer available for your stall.</p> : null}
      {state === 'ready' && error ? <p className="form-error" role="alert">{error} <button type="button" onClick={() => void reload()}>Try again</button></p> : null}
      {ticket && state === 'ready' ? <RequestBody ticket={ticket} timeZone={timeZone} profileId={profile?.id ?? ''} onChanged={() => void reload()} /> : null}
    </ExhibitorShell>
  );
}

function RequestBody({ ticket, timeZone, profileId, onChanged }: {
  ticket: StallTicket;
  timeZone: string;
  profileId: string;
  onChanged: () => void;
}) {
  return (
    <article className="exhibitor-detail">
      <div className="ticket-top">
        <h2>{ticket.publicNo}</h2>
        <span className={'status status-' + ticket.status.toLowerCase()}>{progressText(ticket)}</span>
      </div>
      <p>{serviceText(ticket)}{ticket.priority === 'URGENT' ? ' · Urgent' : ''}</p>
      <p className="exhibitor-place">{stallPlace(ticket) || 'Your stall'}</p>
      <h3>What you reported</h3>
      <p className="description">{ticket.description}</p>
      <h3>Dates</h3>
      <ul className="exhibitor-dates">
        <li>Raised <time dateTime={ticket.createdAt}>{eventTime(ticket.createdAt, timeZone)}</time></li>
        {ticket.status === 'AWAITING_OTP' && ticket.completionRequestedAt ? <li>Completion requested <time dateTime={ticket.completionRequestedAt}>{eventTime(ticket.completionRequestedAt, timeZone)}</time></li> : null}
        {ticket.status === 'CLOSED' && ticket.closedAt ? <li>Completed <time dateTime={ticket.closedAt}>{eventTime(ticket.closedAt, timeZone)}</time></li> : null}
        {ticket.complaintRaisedAt ? <li>Problem reported <time dateTime={ticket.complaintRaisedAt}>{eventTime(ticket.complaintRaisedAt, timeZone)}</time></li> : null}
        {ticket.status === 'CANCELLED' && ticket.cancelledAt ? <li>Cancelled <time dateTime={ticket.cancelledAt}>{eventTime(ticket.cancelledAt, timeZone)}</time></li> : null}
        {(ticket.reopenCount ?? 0) > 0 ? <li>Reopened {ticket.reopenCount === 1 ? 'once' : `${ticket.reopenCount} times`}</li> : null}
      </ul>
      {ticket.status === 'AWAITING_OTP' ? <CompletionPanel ticketId={ticket.id} profileId={profileId} onChanged={onChanged} /> : null}
      {ticket.status === 'COMPLAINT_RAISED' ? <p className="form-success" role="status">Problem reported. A hall manager can review it. Reporting a problem does not by itself reopen the request.</p> : null}
      {complaintAllowed(ticket.status) ? (
        <ComplaintForm ticketId={ticket.id} onChanged={onChanged} />
      ) : null}
      <Activity ticketId={ticket.id} timeZone={timeZone} revision={ticket.status} />
    </article>
  );
}

function CompletionPanel({ ticketId, profileId, onChanged }: { ticketId: string; profileId: string; onChanged: () => void }) {
  const now = useOperationalNow();
  const [code, setCode] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);
  const nowMs = now ?? Date.now();

  useEffect(() => {
    setCode('');
    setExpiresAt('');
    setExpired(false);
    setError('');
  }, [ticketId, profileId]);

  useEffect(() => {
    const clear = () => {
      setCode('');
      setExpiresAt('');
      setExpired(false);
    };
    window.addEventListener(AUTH_LOST_EVENT, clear);
    return () => window.removeEventListener(AUTH_LOST_EVENT, clear);
  }, []);

  useEffect(() => () => {
    setCode('');
  }, [ticketId]);

  async function loadCode() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      const response = await apiFetch('/api/tickets/' + ticketId + '/otp', { credentials: 'include', cache: 'no-store' });
      if (response.status === 403) {
        setCode('');
        setError('This request is no longer available for your stall.');
        onChanged();
        return;
      }
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'The completion code is unavailable'));
      const result = await response.json() as { otp?: string | null; expiresAt?: string; expired?: boolean };
      if (result.expired || !result.otp) {
        setCode('');
        setExpired(true);
        if (result.expiresAt) setExpiresAt(result.expiresAt);
      } else {
        setCode(result.otp);
        setExpired(false);
        if (result.expiresAt) setExpiresAt(result.expiresAt);
      }
    } catch (cause) {
      setCode('');
      setError(cause instanceof Error ? cause.message : 'The completion code is unavailable');
      onChanged();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function regenerate() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError('');
    setCode('');
    try {
      const response = await apiFetch('/api/tickets/' + ticketId + '/otp/regenerate', { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'A new code could not be prepared'));
      pendingRef.current = false;
      setPending(false);
      await loadCode();
    } catch (cause) {
      pendingRef.current = false;
      setError(cause instanceof Error ? cause.message : 'A new code could not be prepared');
      setPending(false);
      onChanged();
    }
  }

  const remaining = code && expiresAt ? countdownLabel(expiresAt, nowMs) : '';
  const timedOut = Boolean(code && remaining === '00:00');

  return (
    <section className="otp-panel" aria-label="Completion code">
      <p>Check the work, then share the completion code with the assigned worker or hall manager.</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {code && !timedOut ? (
        <>
          <p className="otp-code-label">Completion code</p>
          <p className="completion-code" aria-label="Completion code">{code}</p>
          <p className="otp-expiry">Expires in {remaining}</p>
          <button type="button" className="secondary-action" disabled={pending} onClick={() => void regenerate()}>Request a new completion code</button>
        </>
      ) : expired || timedOut ? (
        <>
          <p className="form-error" role="alert">This completion code has expired.</p>
          <button type="button" className="primary" disabled={pending} onClick={() => void regenerate()}>{pending ? 'Preparing…' : 'Prepare a new code'}</button>
        </>
      ) : (
        <button type="button" className="primary" disabled={pending} onClick={() => void loadCode()}>{pending ? 'Loading code…' : 'Show completion code'}</button>
      )}
    </section>
  );
}

function ComplaintForm({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const idempotencyKey = useRef(crypto.randomUUID());
  const submittingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    const form = event.currentTarget;
    const values = new FormData(form);
    const comment = String(values.get('comment') ?? '').trim();
    try {
      const response = await apiFetch('/api/tickets/' + ticketId + '/complaints', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reasonCode: values.get('reasonCode'),
          ...(comment ? { comment } : {}),
          idempotencyKey: idempotencyKey.current,
        }),
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'The problem could not be reported'));
      const body = await response.json() as { status?: string; progressLabel?: string };
      idempotencyKey.current = crypto.randomUUID();
      form.reset();
      const label = progressText({ status: body.status ?? 'COMPLAINT_RAISED', progressLabel: body.progressLabel });
      setResult(body.status === 'REOPENED'
        ? `Problem reported. Current status: ${label}.`
        : `Problem reported. Current status: ${label}. A hall manager can review it. Reporting a problem does not by itself reopen the request.`);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The problem could not be reported');
      onChanged();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <details className="complaint-disclosure">
      <summary>Report a problem</summary>
      <form onSubmit={(event) => void submit(event)}>
        <label>What is still wrong?
          <select name="reasonCode" required disabled={submitting} defaultValue="">
            <option value="">Choose a reason</option>
            <option value="WORK_INCOMPLETE">Work incomplete</option>
            <option value="WORK_QUALITY">Issue returned</option>
            <option value="WRONG_SERVICE">Wrong repair</option>
          </select>
        </label>
        <label>Additional details
          <textarea name="comment" maxLength={500} disabled={submitting} placeholder="Optional note" />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {result ? <p className="form-success" role="status">{result}</p> : null}
        <button type="submit" disabled={submitting}>{submitting ? 'Sending…' : 'Submit report'}</button>
      </form>
    </details>
  );
}

function Activity({ ticketId, timeZone, revision }: { ticketId: string; timeZone: string; revision: string }) {
  const [items, setItems] = useState<Array<{ id: string; createdAt: string; summary?: string }>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (next?: string) => {
    setLoading(true);
    setError('');
    const response = await apiFetch('/api/tickets/' + ticketId + '/activity' + (next ? '?cursor=' + encodeURIComponent(next) : ''), { credentials: 'include', cache: 'no-store' });
    if (response.status === 403) {
      setError('Activity is no longer available for your stall.');
      setLoading(false);
      return;
    }
    if (!response.ok) {
      setError('Activity could not be loaded');
      setLoading(false);
      return;
    }
    const result = await response.json() as { items: Array<{ id: string; createdAt: string; summary?: string; eventType?: string }>; nextCursor: string | null };
    const safe = result.items.map((item) => ({ id: item.id, createdAt: item.createdAt, summary: item.summary || 'Your request was updated.' }));
    setItems((current) => next ? [...current, ...safe] : safe);
    setCursor(result.nextCursor);
    setLoading(false);
  }, [ticketId]);

  useEffect(() => {
    if (!revision) return;
    void load();
  }, [load, revision]);

  return (
    <section className="timeline" aria-label="Activity">
      <h3>Activity</h3>
      {loading && !items.length ? <p className="empty-state">Loading activity…</p> : null}
      {error ? <p className="form-error" role="alert">{error} <button type="button" onClick={() => void load()}>Try again</button></p> : null}
      {!loading && !error && !items.length ? <p className="empty-state">No activity yet.</p> : null}
      {items.map((event) => (
        <div className="timeline-item" key={event.id}>
          <i className="active"></i>
          <div>
            <strong>{event.summary}</strong>
            <span>{eventTime(event.createdAt, timeZone)}</span>
          </div>
        </div>
      ))}
      {cursor ? <button type="button" onClick={() => void load(cursor)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button> : null}
    </section>
  );
}
