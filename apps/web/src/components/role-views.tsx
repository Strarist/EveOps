'use client';

import type { Role, TicketStatus } from '@eveops/contracts';
import { FormEvent, KeyboardEvent, ClipboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, apiErrorMessage, AUTH_LOST_EVENT, subscribeRealtime } from '../lib/api-client';

type Ticket = {
  id: string;
  no: string;
  service: string;
  location: string;
  locationParts: { hall: string; zone: string; stall: string };
  status: TicketStatus;
  age: string;
  assignee: string;
  ownerId?: string;
  description: string;
  priority?: boolean;
  createdAt: string;
  firstStartedAt?: string | null;
  completionRequestedAt?: string | null;
  closedAt?: string | null;
  slaState: 'On track' | 'Response overdue' | 'SLA breached';
  capabilities: {
    advanceHallManagerWork: boolean;
    verifyStallOtp?: boolean;
    emergencyClose: boolean;
  };
};

type ApiTicket = {
  id: string;
  publicNo: string;
  category: string;
  subtype: string;
  status: TicketStatus;
  priority: 'NORMAL' | 'URGENT';
  description: string;
  createdAt: string;
  firstAcceptedAt?: string | null;
  firstAssignedAt?: string | null;
  firstStartedAt?: string | null;
  completionRequestedAt?: string | null;
  closedAt?: string | null;
  pool?: { responseTargetSeconds: number; resolutionTargetSeconds: number } | null;
  hall: { code: string };
  zone?: { code: string };
  stall: { stallCode: string };
  assignments: Array<{ status: string; staff: { name: string } }>;
  currentAssignee: { id: string; name: string } | null;
  lastAssignee: { id: string; name: string } | null;
  queueState: 'QUEUED' | 'ASSIGNED' | 'NONE';
  nextAction: 'NONE' | 'WAIT_FOR_ASSIGNMENT' | 'VERIFY_OTP' | 'WAIT_FOR_OTP_VERIFICATION' | 'STAFF_VERIFY_OTP' | 'STALL_VERIFY_OTP' | 'ASSIGNEE_ACTION' | 'ROUTE';
  slaState: 'ON_TRACK' | 'RESPONSE_OVERDUE' | 'SLA_BREACHED';
  capabilities: {
    advanceHallManagerWork: boolean;
    verifyStallOtp?: boolean;
    emergencyClose: boolean;
  };
};

function formatTicketAge(createdAt: string) {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  if (ageSeconds < 60) return ageSeconds + 's';
  const days = Math.floor(ageSeconds / 86400);
  const hours = Math.floor((ageSeconds % 86400) / 3600);
  const minutes = Math.floor((ageSeconds % 3600) / 60);
  if (days > 0) return days + 'd ' + hours + 'h';
  if (hours > 0) return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
  return String(minutes).padStart(2, '0') + 'm';
}

function mapTicket(ticket: ApiTicket): Ticket {
  const hall = ticket.hall.code;
  const zone = ticket.zone?.code ?? '';
  const stall = ticket.stall.stallCode;
  return {
    id: ticket.id,
    no: ticket.publicNo,
    service: ticket.category.replaceAll('_', ' ') + ' · ' + ticket.subtype,
    location: [hall, zone, stall].filter(Boolean).join(' · '),
    locationParts: { hall, zone, stall },
    status: ticket.status,
    age: formatTicketAge(ticket.createdAt),
    assignee: ticket.currentAssignee?.name
      ?? (['CLOSED', 'CANCELLED'].includes(ticket.status) && ticket.lastAssignee
        ? `Last handled by ${ticket.lastAssignee.name}`
        : undefined)
      ?? (ticket.status === 'CLOSED' || ticket.status === 'CANCELLED'
        ? 'No assignee on record'
        : undefined)
      ?? ticket.assignments[0]?.staff.name
      ?? (ticket.queueState === 'QUEUED' || ticket.status === 'QUEUED' ? 'Waiting in FIFO queue' : 'Not currently assigned'),
    ownerId: ticket.currentAssignee?.id,
    description: ticket.description,
    priority: ticket.priority === 'URGENT',
    createdAt: ticket.createdAt,
    firstStartedAt: ticket.firstStartedAt,
    completionRequestedAt: ticket.completionRequestedAt,
    closedAt: ticket.closedAt,
    slaState: ticket.slaState === 'SLA_BREACHED' ? 'SLA breached' : ticket.slaState === 'RESPONSE_OVERDUE' ? 'Response overdue' : 'On track',
    capabilities: ticket.capabilities ?? { advanceHallManagerWork: false, verifyStallOtp: false, emergencyClose: false },
  };
}

function useApiTickets(query = '') {
  const [items, setItems] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenEventIds = useRef(new Set<string>());
  const seenTicketVersions = useRef(new Map<string, number>());
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const refresh = useCallback(async (cursor?: string, append = false) => {
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (!append) setLoading(true);
    try {
      const parameters = new URLSearchParams(query);
      if (cursor) parameters.set('cursor', cursor);
      const response = await apiFetch('/api/tickets?' + parameters.toString(), { credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Live tickets could not be loaded');
      const result = await response.json() as { items: ApiTicket[]; total: number; nextCursor: string | null };
      if (sequence !== requestSequence.current) return;
      const mapped = result.items.map(mapTicket);
      setItems((current) => append ? [...current, ...mapped] : mapped);
      setTotal(result.total);
      setNextCursor(result.nextCursor);
      setLastUpdatedAt(Date.now());
      setError('');
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Live tickets could not be loaded');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [query]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const unsubscribe = subscribeRealtime({
      onConnection: (state) => {
        setConnection(state);
        if (state === 'live') void refresh();
      },
      onTicket: (event) => {
      if (event.lastEventId) {
        if (seenEventIds.current.has(event.lastEventId)) return;
        seenEventIds.current.add(event.lastEventId);
        if (seenEventIds.current.size > 500) {
          const oldest = seenEventIds.current.values().next().value;
          if (oldest) seenEventIds.current.delete(oldest);
        }
      }
      try {
        const data = JSON.parse(event.data) as { ticketId?: string; version?: number };
        if (data.ticketId && typeof data.version === 'number') {
          const previous = seenTicketVersions.current.get(data.ticketId) ?? -1;
          if (data.version <= previous) return;
          seenTicketVersions.current.set(data.ticketId, data.version);
        }
      } catch {
        // Reconcile unknown event payloads from authoritative REST state.
      }
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void refresh(), 250);
      },
    });
    const reconcile = () => { if (document.visibilityState === 'visible') void refresh(); };
    const authLost = () => {
      setItems([]);
      setTotal(0);
      setNextCursor(null);
      setError('Session expired');
    };
    document.addEventListener('visibilitychange', reconcile);
    window.addEventListener(AUTH_LOST_EVENT, authLost);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      document.removeEventListener('visibilitychange', reconcile);
      window.removeEventListener(AUTH_LOST_EVENT, authLost);
      unsubscribe();
      requestController.current?.abort();
    };
  }, [refresh]);
  return { items, total, nextCursor, loading, error, refresh, loadMore: () => nextCursor ? refresh(nextCursor, true) : Promise.resolve(), connection, lastUpdatedAt };
}

type Profile = {
  id: string;
  name: string;
  role: Role;
  scopes: Array<{
    event: { id: string; name: string; timezone: string };
    hall: { id: string; code: string; name: string } | null;
    stall: { id?: string; stallCode: string; zone: { code: string } } | null;
    serviceType: string | null;
  }>;
};

function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    void apiFetch('/api/auth/profile', { credentials: 'include', cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<Profile> : null)
      .then(setProfile);
    const authLost = () => setProfile(null);
    window.addEventListener(AUTH_LOST_EVENT, authLost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, authLost);
  }, []);
  return profile;
}

function useAuthLoss(clear: () => void) {
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    const listener = () => clearRef.current();
    window.addEventListener(AUTH_LOST_EVENT, listener);
    return () => window.removeEventListener(AUTH_LOST_EVENT, listener);
  }, []);
}

const statusLabels: Record<TicketStatus, string> = {
  NEW: 'Request received',
  QUEUED: 'Waiting for staff',
  ASSIGNED: 'New assignment',
  SNOOZED: 'Snoozed',
  ACCEPTED: 'Accepted',
  IN_PROGRESS: 'Work in progress',
  AWAITING_OTP: 'Awaiting OTP',
  CLOSED: 'Closed · OTP verified',
  COMPLAINT_RAISED: 'Issue reported',
  REOPENED: 'Reopened',
  ESCALATED: 'Escalated',
  CANCELLED: 'Cancelled',
};

function statusLabelFor(value: TicketStatus, audience: 'stall' | 'staff' | 'manager' = 'manager') {
  if (value === 'ASSIGNED' && audience === 'staff') return 'New assignment';
  if (value === 'ASSIGNED' && audience === 'stall') return 'Staff assigned';
  if (value === 'AWAITING_OTP' && audience === 'stall') return 'Waiting for completion verification';
  if (value === 'AWAITING_OTP' && audience === 'staff') return 'Waiting for stall code';
  if (value === 'AWAITING_OTP') return 'Awaiting OTP';
  if (value === 'CLOSED' && audience === 'stall') return 'Completion verified';
  return statusLabels[value];
}

function Status({ value, audience = 'manager' }: { value: TicketStatus; audience?: 'stall' | 'staff' | 'manager' }) {
  return <span className={'status status-' + value.toLowerCase()}>{statusLabelFor(value, audience)}</span>;
}

function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await globalThis.fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.replace('/login');
    router.refresh();
  }
  return <button className="logout" onClick={logout}>Sign out</button>;
}

function shortTime(value: string | null | undefined, timezone = 'UTC') {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, timeStyle: 'short' }).format(new Date(value));
}

function countdownLabel(expiresAt: string | undefined, nowMs: number) {
  if (!expiresAt) return '';
  const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function OtpDigits({ value, empty = false }: { value?: string; empty?: boolean }) {
  const digits = (value ?? '').padEnd(6, ' ').slice(0, 6).split('');
  return (
    <div className="otp-digits" aria-hidden={empty || !value}>
      {digits.map((digit, index) => (
        <span key={index} className={digit.trim() ? 'otp-digit' : 'otp-digit otp-digit-empty'}>{digit.trim() || '·'}</span>
      ))}
    </div>
  );
}

function StaffOtpEntry({ disabled, value, onChange, onSubmit, submitting, error, success }: {
  disabled?: boolean;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string;
  success: string;
}) {
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
  function setDigit(index: number, digit: string) {
    const clean = digit.replace(/\D/g, '').slice(-1);
    const chars = value.padEnd(6, ' ').split('').slice(0, 6);
    chars[index] = clean || ' ';
    const next = chars.join('').replace(/ /g, '').slice(0, 6);
    onChange(next);
    if (clean && index < 5) inputsRef.current[index + 1]?.focus();
  }
  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && !value[index] && index > 0) {
      event.preventDefault();
      onChange(value.slice(0, index - 1));
      inputsRef.current[index - 1]?.focus();
    }
  }
  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    onChange(pasted);
    inputsRef.current[Math.min(Math.max(pasted.length - 1, 0), 5)]?.focus();
  }
  return (
    <div className="otp-verify-panel">
      <p className="otp-kicker">Completion verification</p>
      <p>Ask the stall representative for the 6-digit completion code.</p>
      <div className="otp-entry" role="group" aria-label="Completion code">
        {Array.from({ length: 6 }, (_, index) => (
          <input
            key={index}
            ref={(node) => { inputsRef.current[index] = node; }}
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            pattern="[0-9]*"
            maxLength={1}
            aria-label={`Digit ${index + 1}`}
            disabled={disabled || submitting || !!success}
            value={value[index] ?? ''}
            onChange={(event) => setDigit(index, event.target.value)}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={onPaste}
          />
        ))}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {success && <p className="form-success" role="status">{success}</p>}
      <button
        type="button"
        className="primary full-width"
        disabled={disabled || submitting || value.length !== 6 || !!success}
        onClick={onSubmit}
      >
        {success ? 'Ticket completed' : submitting ? 'Verifying code…' : 'Verify & close ticket'}
      </button>
      <p className="otp-hint">Only enter the code after the stall confirms the work is complete.</p>
    </div>
  );
}

function TicketCard({ ticket, actions = false, actionLabel = 'Accept assignment', actionDisabled = false, onAccept, onSnooze, audience = 'manager', loadingLabel }: {
  ticket: Ticket;
  actions?: boolean;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAccept?: () => void;
  onSnooze?: () => void;
  audience?: 'stall' | 'staff' | 'manager';
  loadingLabel?: string;
}) {
  return (
    <article className="ticket-card">
      <div className="ticket-top"><span className="ticket-no">{ticket.no}</span><Status value={ticket.status} audience={audience} /></div>
      <h3>{ticket.service}</h3>
      <p className="description">{ticket.description}</p>
      <div className="location location-emphasis">
        <span>{ticket.locationParts.hall} · {ticket.locationParts.zone}</span>
        <strong>Stall {ticket.locationParts.stall}</strong>
      </div>
      <div className="ticket-meta">
        <span>Age <strong>{ticket.age}</strong></span>
        <span>{audience === 'stall' ? 'Handled by' : 'Owner'} <strong>{ticket.assignee}</strong></span>
      </div>
      {actions && (
        <div className="ticket-actions">
          <button className="primary" disabled={actionDisabled} onClick={onAccept}>{actionDisabled && loadingLabel ? loadingLabel : actionLabel}</button>
          {ticket.status === 'ASSIGNED' && <button disabled={actionDisabled} onClick={onSnooze}>Snooze 10 min</button>}
        </div>
      )}
    </article>
  );
}

function ComplaintDisclosure({ ticketId, summary, onSuccess }: { ticketId: string; summary: string; onSuccess: () => Promise<unknown> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const idempotencyKey = useRef(crypto.randomUUID());

  async function submitComplaint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    setSuccess('');
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      const response = await apiFetch('/api/tickets/' + ticketId + '/complaints', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reasonCode: values.get('reasonCode'),
          comment: values.get('comment'),
          idempotencyKey: idempotencyKey.current,
        }),
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Complaint could not be raised'));
      idempotencyKey.current = crypto.randomUUID();
      form.reset();
      setSuccess('Complaint recorded. Hall Manager has been notified.');
      await onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Complaint could not be raised');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <details className="complaint-disclosure">
      <summary>{summary}</summary>
      <form onSubmit={(event) => void submitComplaint(event)}>
        <label>What is still wrong?<select name="reasonCode" required disabled={submitting}><option value="">Choose reason</option><option value="WORK_INCOMPLETE">Work incomplete</option><option value="WORK_QUALITY">Issue returned</option><option value="WRONG_SERVICE">Wrong repair</option></select></label>
        <label>Additional details<textarea name="comment" maxLength={500} disabled={submitting} placeholder="Optional note" /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {success && <p className="form-success" role="status">{success}</p>}
        <button type="submit" disabled={submitting}>{submitting ? 'Submitting complaint…' : 'Submit complaint'}</button>
      </form>
    </details>
  );
}

export function StallWorkspace() {
  const profile = useProfile();
  const { items, total, loading, error: loadError, refresh, connection } = useApiTickets('view=active');
  const { items: closedItems, loading: closedLoading } = useApiTickets('view=closed&limit=5');
  const [showForm, setShowForm] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [submitted, setSubmitted] = useState('');
  const [category, setCategory] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [otpByTicket, setOtpByTicket] = useState<Record<string, string>>({});
  const [otpExpiryByTicket, setOtpExpiryByTicket] = useState<Record<string, string>>({});
  const [otpExpiredByTicket, setOtpExpiredByTicket] = useState<Record<string, boolean>>({});
  const [otpPending, setOtpPending] = useState<Record<string, boolean>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const idempotencyKey = useRef('');
  useAuthLoss(() => {
    setOtpByTicket({});
    setOtpExpiryByTicket({});
    setOtpExpiredByTicket({});
    setOtpPending({});
    setSubmitted('');
  });
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const stallScope = profile?.scopes.find((scope) => scope.stall);
  const locationLabel = stallScope
    ? [stallScope.hall?.name, 'Zone ' + stallScope.stall!.zone.code, 'Stall ' + stallScope.stall!.stallCode].filter(Boolean).join(' / ')
    : 'Loading assigned location…';

  async function loadOtp(ticketId: string) {
    if (otpPending[ticketId]) return;
    setOtpPending((current) => ({ ...current, [ticketId]: true }));
    try {
      const response = await apiFetch('/api/tickets/' + ticketId + '/otp', { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Completion code is unavailable'));
      const result = await response.json() as { otp?: string | null; expiresAt?: string; expired?: boolean };
      if (result.expired || !result.otp) {
        setOtpByTicket((current) => {
          const next = { ...current };
          delete next[ticketId];
          return next;
        });
        setOtpExpiredByTicket((current) => ({ ...current, [ticketId]: true }));
        if (result.expiresAt) setOtpExpiryByTicket((current) => ({ ...current, [ticketId]: result.expiresAt! }));
      } else {
        setOtpByTicket((current) => ({ ...current, [ticketId]: result.otp! }));
        setOtpExpiredByTicket((current) => ({ ...current, [ticketId]: false }));
        if (result.expiresAt) setOtpExpiryByTicket((current) => ({ ...current, [ticketId]: result.expiresAt! }));
      }
      setSubmitError('');
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : 'Completion code is unavailable');
    } finally {
      setOtpPending((current) => ({ ...current, [ticketId]: false }));
    }
  }

  async function regenerateOtp(ticketId: string) {
    if (otpPending[ticketId]) return;
    setOtpPending((current) => ({ ...current, [ticketId]: true }));
    try {
      const response = await apiFetch('/api/tickets/' + ticketId + '/otp/regenerate', { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Could not generate a new code'));
      setOtpPending((current) => ({ ...current, [ticketId]: false }));
      await loadOtp(ticketId);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : 'Could not generate a new code');
      setOtpPending((current) => ({ ...current, [ticketId]: false }));
    }
  }

  useEffect(() => {
    for (const ticket of items) {
      if (ticket.status === 'AWAITING_OTP' && !otpByTicket[ticket.id] && !otpExpiredByTicket[ticket.id] && !otpPending[ticket.id]) {
        void loadOtp(ticket.id);
      }
      if (ticket.status !== 'AWAITING_OTP' && otpByTicket[ticket.id]) {
        setOtpByTicket((current) => {
          const next = { ...current };
          delete next[ticket.id];
          return next;
        });
      }
    }
    // Auto-fetch once per awaiting ticket; pending/otp maps intentionally omitted to avoid loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await apiFetch('/api/tickets', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category,
          subtype: category === 'ELECTRICAL' ? String(form.get('subtype') ?? '') : 'General',
          description: String(form.get('description') ?? ''),
          priority: form.get('urgent') ? 'URGENT' : 'NORMAL',
          idempotencyKey: idempotencyKey.current || (idempotencyKey.current = crypto.randomUUID()),
        }),
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Ticket could not be created'));
      const result = await response.json() as { publicNo?: string };
      if (!result.publicNo) throw new Error('Ticket could not be created');
      setSubmitted(result.publicNo);
      idempotencyKey.current = '';
      await refresh();
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : 'Ticket could not be created');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mobile-page">
      <main className="mobile-shell">
        <header className="mobile-header">
          <div><span className="eyebrow">{stallScope?.event.name ?? 'EveOps event'}</span><h1>{stallScope?.stall ? 'Stall ' + stallScope.stall.stallCode : 'Your stall'}</h1></div>
          <span className="online">{connection === 'live' ? 'Live' : connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span>
        </header>
        {submitted ? (
          <section className="success-panel">
            <span className="success-mark" aria-hidden="true">✓</span>
            <h2>Ticket {submitted} confirmed</h2>
            <p>The server confirmed your ticket. Hall Manager notified; waiting for assignment.</p>
            <button onClick={() => { setSubmitted(''); setShowForm(false); }}>View ticket</button>
          </section>
        ) : showForm ? (
          <form className="raise-form" onSubmit={submit}>
            <button type="button" className="back" onClick={() => setShowForm(false)}>← Back</button>
            <span className="eyebrow">Locked location · {locationLabel}</span>
            <h2>What do you need?</h2>
            <fieldset className="service-grid">
              <legend>Service category</legend>
              <label><input type="radio" name="service" required value="ELECTRICAL" onChange={() => setCategory('ELECTRICAL')} />Electrical</label>
              <label><input type="radio" name="service" value="HOUSE_HELP" onChange={() => setCategory('HOUSE_HELP')} />House Help</label>
              <label><input type="radio" name="service" value="HALL_MANAGER" onChange={() => setCategory('HALL_MANAGER')} />Hall Manager</label>
            </fieldset>
            {category === 'ELECTRICAL' && <label className="field">Electrical subtype<select name="subtype" required><option value="">Choose subtype</option><option value="NCP">NCP</option><option value="Lighting">Lighting</option></select></label>}
            <label className="field">Brief description<textarea name="description" required minLength={3} maxLength={500} placeholder="Tell us what needs attention" /></label>
            <label className="urgent"><input type="checkbox" name="urgent" /> Mark as urgent</label>
            {submitError && <div className="form-error" role="alert">{submitError}</div>}
            <button className="primary full-width" type="submit" disabled={submitting || !category}>{submitting ? 'Confirming…' : 'Raise ticket'}</button>
          </form>
        ) : showHelp ? (
          <section className="success-panel">
            <h2>Need operational help?</h2>
            <p>Raise a Hall Manager ticket for event assistance. For an existing request, include the ticket number when speaking with your Hall Manager.</p>
            <button className="primary" onClick={() => { idempotencyKey.current = crypto.randomUUID(); setShowHelp(false); setShowForm(true); }}>Raise a help ticket</button>
            <button onClick={() => setShowHelp(false)}>Back to tickets</button>
          </section>
        ) : (
          <>
            <button className="raise" onClick={() => { idempotencyKey.current = crypto.randomUUID(); setShowForm(true); }}><span aria-hidden="true">＋</span> Raise a ticket</button>
            <section>
              <div className="section-title"><h2>Active requests</h2><span>{total} open</span></div>
              {submitError && <div className="form-error" role="alert">{submitError}</div>}
              {loading ? <p className="empty-state">Loading your requests…</p> : loadError ? <p className="form-error">{loadError}</p> : items.length ? (showAll ? items : items.slice(0, 3)).map((ticket) => (
                <div key={ticket.id}>
                  <TicketCard ticket={ticket} audience="stall" />
                  {ticket.status === 'AWAITING_OTP' && (
                    <div className="otp-panel otp-display-panel">
                      <p className="otp-kicker">Staff has requested completion</p>
                      <p>Check the work before sharing this code.</p>
                      {(ticket.firstStartedAt || ticket.completionRequestedAt) && (
                        <div className="otp-milestones">
                          {ticket.firstStartedAt && <span>Work started · {shortTime(ticket.firstStartedAt) ?? '—'}</span>}
                          {ticket.completionRequestedAt && <span>Completion requested · {shortTime(ticket.completionRequestedAt) ?? '—'}</span>}
                        </div>
                      )}
                      {otpByTicket[ticket.id] && countdownLabel(otpExpiryByTicket[ticket.id], nowMs) !== '00:00' ? (
                        <>
                          <p className="otp-code-label">Completion code</p>
                          <div aria-label={`Completion code ${otpByTicket[ticket.id].split('').join(' ')}`}>
                            <OtpDigits value={otpByTicket[ticket.id]} />
                          </div>
                          <p className="otp-expiry">Expires in {countdownLabel(otpExpiryByTicket[ticket.id], nowMs)}</p>
                          <p className="otp-hint">Tell this code to the assigned worker or hall manager only if the work is complete.</p>
                          <button type="button" className="secondary-action" disabled={otpPending[ticket.id]} onClick={() => void regenerateOtp(ticket.id)}>
                            Request new completion code
                          </button>
                        </>
                      ) : otpExpiredByTicket[ticket.id] || (otpByTicket[ticket.id] && countdownLabel(otpExpiryByTicket[ticket.id], nowMs) === '00:00') ? (
                        <>
                          <p className="form-error" role="alert">Verification code expired</p>
                          <button type="button" className="primary" disabled={otpPending[ticket.id]} onClick={() => void regenerateOtp(ticket.id)}>
                            {otpPending[ticket.id] ? 'Generating…' : 'Generate new code'}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="primary" disabled={otpPending[ticket.id]} onClick={() => void loadOtp(ticket.id)}>
                          {otpPending[ticket.id] ? 'Loading code…' : 'Show completion code'}
                        </button>
                      )}
                      <ComplaintDisclosure ticketId={ticket.id} summary="Work is not satisfactory" onSuccess={async () => { setOtpByTicket((current) => { const next = { ...current }; delete next[ticket.id]; return next; }); await refresh(); }} />
                    </div>
                  )}
                </div>
              )) : <p className="empty-state">No active requests for this stall.</p>}
            </section>
            <section>
              <div className="section-title"><h2>Recently resolved</h2><button className="link" onClick={() => setShowAll(true)}>View all</button></div>
              {closedLoading ? <p className="empty-state">Loading resolved requests…</p> : closedItems.length ? closedItems.map((ticket) => (
                <div key={ticket.id}>
                  <div className="recent"><Status value="CLOSED" audience="stall" /><strong>{ticket.no} · {ticket.service}</strong><span>{ticket.closedAt ? `Closed · ${shortTime(ticket.closedAt)}` : `${ticket.age} since raised`}</span></div>
                  <ComplaintDisclosure ticketId={ticket.id} summary="Report a problem" onSuccess={refresh} />
                </div>
              )) : <p className="empty-state">No resolved requests yet.</p>}
            </section>
          </>
        )}
        <nav className="bottom-nav" aria-label="Stall navigation"><button onClick={() => { setShowHelp(false); setShowAll(false); }}>Home</button><button onClick={() => { setShowHelp(false); setShowAll(true); }}>My tickets</button><button onClick={() => setShowHelp(true)}>Help</button><LogoutButton /></nav>
      </main>
    </div>
  );
}

export function StaffWorkspace() {
  const profile = useProfile();
  const { items, loading, error: loadError, refresh, connection } = useApiTickets('view=active');
  const { items: history } = useApiTickets('view=closed&limit=10');
  const [actionError, setActionError] = useState('');
  const [otpValue, setOtpValue] = useState('');
  const [otpError, setOtpError] = useState('');
  const [otpSuccess, setOtpSuccess] = useState('');
  const [availability, setAvailability] = useState<'ON_DUTY' | 'PAUSED' | 'OFF_DUTY' | 'OFFLINE'>('OFF_DUTY');
  const [workload, setWorkload] = useState({ activeCount: 0, completedToday: 0, capacity: 0 });
  const [actionPending, setActionPending] = useState(false);
  const [section, setSection] = useState<'task' | 'history' | 'availability'>('task');
  useAuthLoss(() => {
    setAvailability('OFF_DUTY');
    setWorkload({ activeCount: 0, completedToday: 0, capacity: 0 });
    setActionError('Session expired');
    setActionPending(false);
    setOtpValue('');
    setOtpError('');
    setOtpSuccess('');
  });
  const current = items[0];

  useEffect(() => {
    setOtpValue('');
    setOtpError('');
    setOtpSuccess('');
  }, [current?.id, current?.status]);

  const refreshWorkload = useCallback(async () => {
    const response = await apiFetch('/api/workforce/me', { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json() as typeof workload & { availability: typeof availability };
    setAvailability(result.availability);
    setWorkload(result);
  }, []);
  useEffect(() => { void refreshWorkload(); }, [refreshWorkload]);

  async function setAvailabilityValue(value: 'ON_DUTY' | 'PAUSED' | 'OFF_DUTY') {
    setActionPending(true);
    const response = await apiFetch('/api/workforce/availability', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!response.ok) {
      setActionError(await apiErrorMessage(response, 'Availability could not be updated'));
      setActionPending(false);
      return;
    }
    setActionError('');
    setAvailability(value);
    await refreshWorkload();
    await refresh();
    setActionPending(false);
  }

  async function transition() {
    if (!current) return;
    if (!['ASSIGNED', 'SNOOZED', 'ACCEPTED', 'IN_PROGRESS'].includes(current.status)) return;
    setActionPending(true);
    const next = current.status === 'ACCEPTED' ? 'IN_PROGRESS' : current.status === 'IN_PROGRESS' ? 'AWAITING_OTP' : 'ACCEPTED';
    const response = await apiFetch('/api/tickets/' + current.id + '/transition', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: next }),
    });
    if (!response.ok) {
      setActionError(await apiErrorMessage(response, next === 'AWAITING_OTP' ? 'Could not request completion. Try again.' : 'Action could not be confirmed'));
      setActionPending(false);
      return;
    }
    setActionError('');
    await refresh();
    await refreshWorkload();
    setActionPending(false);
  }

  async function snooze() {
    if (!current) return;
    setActionPending(true);
    const response = await apiFetch('/api/tickets/' + current.id + '/snooze', { method: 'POST', credentials: 'include' });
    if (!response.ok) {
      setActionError(await apiErrorMessage(response, 'Snooze could not be confirmed'));
      setActionPending(false);
      return;
    }
    setActionError('');
    await refresh();
    setActionPending(false);
  }

  async function verifyOtp() {
    if (!current || otpValue.length !== 6 || actionPending) return;
    setActionPending(true);
    setOtpError('');
    const response = await apiFetch('/api/tickets/' + current.id + '/otp/verify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ otp: otpValue }),
    });
    if (!response.ok) {
      setOtpError(await apiErrorMessage(response, 'Could not verify the code. Try again.'));
      setActionPending(false);
      return;
    }
    setOtpSuccess('Ticket completed');
    setActionError('');
    await refresh();
    await refreshWorkload();
    setActionPending(false);
  }

  const actionLabel = current?.status === 'ACCEPTED'
    ? 'Start work'
    : current?.status === 'IN_PROGRESS'
      ? 'Request completion'
      : 'Accept assignment';
  const loadingLabel = current?.status === 'ACCEPTED'
    ? 'Starting…'
    : current?.status === 'IN_PROGRESS'
      ? 'Requesting completion…'
      : 'Accepting…';
  const atCapacity = workload.capacity > 0 && workload.activeCount >= workload.capacity;

  return (
    <div className="mobile-page">
      <main className="mobile-shell staff">
        <header className="mobile-header">
          <div>
            <span className="eyebrow">{profile?.scopes[0]?.event.name ?? 'Current shift'} · {connection === 'live' ? 'Live' : 'Reconnecting'}</span>
            <h1>{profile?.name ?? 'Service workspace'}</h1>
          </div>
          <span className={'duty duty-badge ' + availability.toLowerCase()} aria-label={`Availability ${availability.replaceAll('_', ' ')}`}>
            {availability === 'ON_DUTY' ? 'On duty' : availability === 'PAUSED' ? 'Paused' : 'Off duty'}
          </span>
        </header>
        {section === 'task' && (
          <>
            {current && ['ASSIGNED', 'SNOOZED'].includes(current.status) && (
              <div className="alert-line">
                <strong>New assignment</strong>
                <span>Accept this job or snooze once for 10 minutes.</span>
              </div>
            )}
            {actionError && <div className="form-error" role="alert">{actionError}</div>}
            {loading ? <p className="empty-state">Loading current task…</p> : loadError ? <p className="form-error">{loadError}</p> : current ? (
              <>
                <TicketCard
                  ticket={current}
                  audience="staff"
                  actions={['ASSIGNED', 'SNOOZED', 'ACCEPTED', 'IN_PROGRESS'].includes(current.status)}
                  actionLabel={actionLabel}
                  actionDisabled={actionPending}
                  loadingLabel={loadingLabel}
                  onAccept={() => void transition()}
                  onSnooze={() => void snooze()}
                />
                {current.status === 'AWAITING_OTP' && (
                  <StaffOtpEntry
                    value={otpValue}
                    onChange={(next) => { setOtpValue(next); setOtpError(''); }}
                    onSubmit={() => void verifyOtp()}
                    submitting={actionPending}
                    error={otpError}
                    success={otpSuccess}
                  />
                )}
              </>
            ) : <p className="empty-state">No current assignment.</p>}
            <section>
              <div className="section-title"><h2>Today</h2></div>
              <div className="stats-row">
                <div><strong>{workload.completedToday}</strong><span>Completed</span></div>
                <div><strong>{workload.activeCount}</strong><span>Active{atCapacity ? ' · At capacity' : ''}</span></div>
                <div><strong>{workload.capacity}</strong><span>Capacity</span></div>
              </div>
            </section>
          </>
        )}
        {section === 'history' && (
          <section>
            <div className="section-title"><h2>Recent history</h2></div>
            {history.length ? history.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} audience="staff" />) : <p className="empty-state">No completed work yet.</p>}
          </section>
        )}
        {section === 'availability' && (
          <section className="availability-panel">
            <div className="section-title"><h2>Availability</h2></div>
            <p>Choose how new work should reach you. Active tickets stay with you until closed or reassigned.</p>
            <button type="button" className={availability === 'ON_DUTY' ? 'primary' : 'secondary-action'} disabled={actionPending} onClick={() => void setAvailabilityValue('ON_DUTY')}>On duty · ready for new assignments</button>
            <button type="button" className={availability === 'PAUSED' ? 'primary' : 'secondary-action'} disabled={actionPending} onClick={() => void setAvailabilityValue('PAUSED')}>Paused · finish current work, no new jobs</button>
            <button type="button" className={availability === 'OFF_DUTY' ? 'primary' : 'secondary-action'} disabled={actionPending} onClick={() => void setAvailabilityValue('OFF_DUTY')}>Off duty · not available</button>
          </section>
        )}
        <nav className="bottom-nav" aria-label="Staff navigation">
          <button type="button" className={section === 'task' ? 'nav-active' : undefined} onClick={() => setSection('task')}>Current task</button>
          <button type="button" className={section === 'history' ? 'nav-active' : undefined} onClick={() => setSection('history')}>History</button>
          <button type="button" className={section === 'availability' ? 'nav-active' : undefined} onClick={() => setSection('availability')}>Availability</button>
          <LogoutButton />
        </nav>
      </main>
    </div>
  );
}

const navByRole: Record<'HALL_MANAGER' | 'ADMIN', string[]> = {
  HALL_MANAGER: ['Hall overview', 'Live tickets', 'Staff', 'Exceptions', 'Search'],
  ADMIN: ['Command center', 'Tickets', 'Halls / Zones / Stalls', 'Workforce', 'Reports', 'Masters', 'Audit'],
};

type TimingRecord = {
  id: string;
  eventTimezone: string;
  createdAt: string;
  firstAssignedAt: string | null;
  firstAcceptedAt: string | null;
  firstStartedAt: string | null;
  completionRequestedAt: string | null;
  closedAt: string | null;
  raiseToAssignSeconds: number | null;
  assignToAcceptSeconds: number | null;
  mobilizationSeconds: number | null;
  activeWorkSeconds: number | null;
  otpWaitSeconds: number | null;
  totalResolutionSeconds: number | null;
  workCycles: Array<{ attempt: number; assignedAt: string; acceptedAt: string | null; startedAt: string | null; completionRequestedAt: string | null; releasedAt: string | null }>;
};

type TicketDetail = ApiTicket & {
  firstAssignedAt?: string | null;
  firstAcceptedAt?: string | null;
  firstStartedAt?: string | null;
  completionRequestedAt?: string | null;
  closedAt?: string | null;
  assignmentHistory?: Array<{ id: string; status: string; assignedAt: string; releasedAt: string | null; staff: { id?: string; name: string; employeeCode?: string | null } }>;
  events: Array<{ id: string; eventType: string; fromStatus: TicketStatus | null; toStatus: TicketStatus | null; metadata: unknown; createdAt: string; actor: { name: string } | null }>;
  assignments: Array<{ id: string; status?: string; assignedAt: string; acceptedAt: string | null; startedAt: string | null; completionRequestedAt: string | null; releasedAt: string | null; releaseReason: string | null; staff: { id?: string; name: string; employeeCode?: string | null } }>;
  complaints: Array<{ id: string; reasonCode: string; comment: string | null; createdAt: string; resolution: string | null }>;
  otpChallenges?: Array<{ id: string; createdAt: string; expiresAt: string; verifiedAt: string | null; attempts: number }>;
};

function duration(value: number | null | undefined) {
  if (value == null) return 'Pending';
  if (value < 60) return value + 's';
  return Math.floor(value / 60) + 'm ' + String(value % 60).padStart(2, '0') + 's';
}

function eventTime(value: string | null | undefined, timezone = 'UTC') {
  if (!value) return 'Pending';
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function TicketDrawer({ ticket, timing, detail, eligibleStaff, onPing, onReassign, onReopen, onEscalate, onOverrideClose, onAdvance, onPrioritize, onCancel, onVerifyOtp, canAdmin, canAdvance, canEmergencyClose, canVerifyOtp }: {
  ticket: Ticket;
  timing?: TimingRecord;
  detail?: TicketDetail;
  eligibleStaff: Array<{ user: { id: string; name: string; employeeCode?: string | null }; pool: { category: string; subtype: string } }>;
  onPing: (message: string) => Promise<unknown>;
  onReassign: (staffId: string, reason: string) => Promise<unknown>;
  onReopen: (reason: string) => Promise<unknown>;
  onEscalate: (reason: string) => Promise<unknown>;
  onOverrideClose: (reason: string) => Promise<unknown>;
  onAdvance?: () => void;
  onPrioritize: (reason: string) => Promise<unknown>;
  onCancel: (reason: string) => Promise<unknown>;
  onVerifyOtp?: (otp: string) => Promise<boolean>;
  canAdmin: boolean;
  canAdvance: boolean;
  canEmergencyClose: boolean;
  canVerifyOtp?: boolean;
}) {
  const [pendingAction, setPendingAction] = useState<'ping' | 'reassign' | 'reopen' | 'escalate' | 'override' | 'prioritize' | 'cancel' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [otpValue, setOtpValue] = useState('');
  const [otpError, setOtpError] = useState('');
  const [otpSuccess, setOtpSuccess] = useState('');
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  useEffect(() => {
    setOtpValue('');
    setOtpError('');
    setOtpSuccess('');
    setOtpSubmitting(false);
  }, [ticket.id, ticket.status]);
  const milestones = [
    ['Raised', timing?.createdAt ?? detail?.createdAt, null as string | null],
    ['Assigned', timing?.firstAssignedAt ?? detail?.firstAssignedAt, timing?.raiseToAssignSeconds != null ? duration(timing.raiseToAssignSeconds) + ' after raise' : null],
    ['Accepted', timing?.firstAcceptedAt ?? detail?.firstAcceptedAt, timing?.assignToAcceptSeconds != null ? duration(timing.assignToAcceptSeconds) + ' after assignment' : null],
    ['Work started', timing?.firstStartedAt ?? detail?.firstStartedAt, timing?.mobilizationSeconds != null ? duration(timing.mobilizationSeconds) + ' after acceptance' : null],
    ['Completion requested', timing?.completionRequestedAt ?? detail?.completionRequestedAt, timing?.activeWorkSeconds != null ? duration(timing.activeWorkSeconds) + ' work duration' : null],
    ['Closed', timing?.closedAt ?? detail?.closedAt, timing?.otpWaitSeconds != null ? duration(timing.otpWaitSeconds) + ' verification wait' : (ticket.status === 'AWAITING_OTP' ? 'Pending verification' : null)],
  ];
  return (
    <aside className="drawer" aria-label={'Ticket ' + ticket.no + ' detail'}>
      <div className="drawer-head"><div><span className="eyebrow">{ticket.no}</span><h2>{ticket.service}</h2></div><Status value={ticket.status} audience="manager" /></div>
      <p className="description">{ticket.description}</p>
      <div className="drawer-location location-emphasis"><span>{ticket.locationParts.hall} · {ticket.locationParts.zone}</span><strong>Stall {ticket.locationParts.stall}</strong></div>
      <div className="cycles"><h3>Assignment</h3><div><strong>{detail?.currentAssignee?.name ?? (ticket.status === 'CLOSED' || ticket.status === 'CANCELLED' ? (detail?.lastAssignee?.name ? `Last handled by ${detail.lastAssignee.name}` : ticket.assignee) : ticket.assignee)}</strong><span>{detail?.currentAssignee ? 'Current assignee' : (detail?.lastAssignee ? 'Last assignee' : 'Queue / ownership')}</span></div></div>
      <div className="timing"><h3>Service timing</h3><div className="timing-strip"><span><b>{duration(timing?.raiseToAssignSeconds)}</b>Dispatch</span><span><b>{duration(timing?.assignToAcceptSeconds)}</b>Response</span><span><b>{duration(timing?.mobilizationSeconds)}</b>Mobilize</span><span><b>{duration(timing?.activeWorkSeconds)}</b>Work</span><span><b>{duration(timing?.otpWaitSeconds)}</b>OTP wait</span><span><b>{duration(timing?.totalResolutionSeconds)}</b>Total</span></div></div>
      <div className="timeline"><h3>Lifecycle milestones</h3>{milestones.map(([event, time, relative], index) => <div key={event} className="timeline-item"><i className={time ? 'active' : ''}></i><div><strong>{event}</strong><span>{time ? eventTime(time, timing?.eventTimezone) : (event === 'Closed' && ticket.status === 'AWAITING_OTP' ? 'Pending verification' : '—')}</span>{relative && <span>{relative}</span>}</div><time>{index === 0 ? 'Event time' : ''}</time></div>)}</div>
      {!!timing?.workCycles.length && <div className="cycles"><h3>Work cycles</h3>{timing.workCycles.map((cycle) => <div key={cycle.attempt}><strong>Attempt {cycle.attempt}</strong><span>{eventTime(cycle.assignedAt, timing.eventTimezone)} · {cycle.releasedAt ? 'Completed/released' : 'Active'}</span></div>)}</div>}
      {!!detail?.complaints.length && <div className="cycles"><h3>Complaints</h3>{detail.complaints.map((complaint) => <div key={complaint.id}><strong>{complaint.reasonCode.replaceAll('_', ' ')}</strong><span>{complaint.comment || 'No additional note'} · {eventTime(complaint.createdAt, timing?.eventTimezone)}</span></div>)}</div>}
      {!!detail?.events.length && <div className="timeline"><h3>Audit timeline</h3>{detail.events.map((event) => <div className="timeline-item" key={event.id}><i className="active"></i><div><strong>{event.eventType.replaceAll('_', ' ')}</strong><span>{event.actor?.name ?? 'System'} · {eventTime(event.createdAt, timing?.eventTimezone)}</span></div></div>)}</div>}
      {canVerifyOtp && ticket.status === 'AWAITING_OTP' && onVerifyOtp && (
        <StaffOtpEntry
          value={otpValue}
          onChange={(next) => { setOtpValue(next); setOtpError(''); }}
          onSubmit={() => {
            if (otpValue.length !== 6 || otpSubmitting) return;
            setOtpSubmitting(true);
            void onVerifyOtp(otpValue)
              .then((ok) => {
                if (ok) {
                  setOtpSuccess('Completion verified. Ticket closed.');
                  setOtpError('');
                } else {
                  setOtpError('Could not verify the code. Try again.');
                }
              })
              .catch(() => setOtpError('Could not verify the code. Try again.'))
              .finally(() => setOtpSubmitting(false));
          }}
          submitting={otpSubmitting}
          disabled={!!otpSuccess}
          error={otpError}
          success={otpSuccess}
        />
      )}
      <div className="drawer-actions">
        {canAdvance && ticket.service.startsWith('HALL MANAGER') && ['ASSIGNED', 'SNOOZED', 'ACCEPTED', 'IN_PROGRESS'].includes(ticket.status) && <button className="primary" onClick={onAdvance}>{ticket.status === 'ACCEPTED' ? 'Start work' : ticket.status === 'IN_PROGRESS' ? 'Request completion' : 'Accept'}</button>}
        {['ASSIGNED', 'SNOOZED', 'ACCEPTED'].includes(ticket.status) && <><button onClick={() => setPendingAction('ping')}>Ping staff</button><button onClick={() => setPendingAction('reassign')}>Reassign</button></>}
        {['CLOSED', 'COMPLAINT_RAISED'].includes(ticket.status) && <button onClick={() => setPendingAction('reopen')}>Reopen</button>}
        {ticket.status === 'QUEUED' && <button onClick={() => setPendingAction('prioritize')}>Prioritize</button>}
        {['SNOOZED', 'IN_PROGRESS', 'COMPLAINT_RAISED'].includes(ticket.status) && <button className="critical-button" onClick={() => setPendingAction('escalate')}>Escalate</button>}
        {canEmergencyClose && ['AWAITING_OTP', 'ESCALATED'].includes(ticket.status) && <button className="critical-button" onClick={() => setPendingAction('override')}>Emergency close</button>}
        {canAdmin && ['NEW', 'QUEUED'].includes(ticket.status) && <button className="critical-button" onClick={() => setPendingAction('cancel')}>Cancel</button>}
      </div>
      {pendingAction && <form className="authority-action" onSubmit={(event) => {
        event.preventDefault();
        if (submitting) return;
        const values = new FormData(event.currentTarget);
        const reason = String(values.get('reason') ?? '').trim();
        const staffId = String(values.get('staffId') ?? '');
        setSubmitting(true);
        const action = pendingAction === 'ping' ? onPing(reason)
          : pendingAction === 'reassign' ? onReassign(staffId, reason)
            : pendingAction === 'reopen' ? onReopen(reason)
              : pendingAction === 'escalate' ? onEscalate(reason)
                : pendingAction === 'override' ? onOverrideClose(reason)
                  : pendingAction === 'prioritize' ? onPrioritize(reason)
                    : onCancel(reason);
        void Promise.resolve(action)
          .then((result) => { if (result !== false) setPendingAction(null); })
          .catch(() => undefined)
          .finally(() => setSubmitting(false));
      }}>
        {pendingAction === 'reassign' && <label>Eligible worker<select name="staffId" required disabled={submitting}><option value="">Choose worker</option>{eligibleStaff.map((membership) => <option key={membership.user.id} value={membership.user.id}>{membership.user.name}{membership.user.employeeCode ? ` · ${membership.user.employeeCode}` : ''} · {membership.pool.category} {membership.pool.subtype}</option>)}</select></label>}
        <label>{pendingAction === 'ping' ? 'Message' : 'Required reason'}<textarea name="reason" required minLength={3} maxLength={500} disabled={submitting} /></label>
        <div><button type="button" disabled={submitting} onClick={() => setPendingAction(null)}>Back</button><button className={['override', 'cancel'].includes(pendingAction) ? 'critical-button' : 'primary'} type="submit" disabled={submitting}>{submitting ? 'Confirming…' : 'Confirm action'}</button></div>
      </form>}
    </aside>
  );
}

export function ManagementWorkspace({ role }: { role: 'HALL_MANAGER' | 'ADMIN' }) {
  const profile = useProfile();
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const ticketQuery = new URLSearchParams({
    view: 'all',
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(categoryFilter ? { category: categoryFilter } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  }).toString();
  const { items, total, nextCursor, loading, error: loadError, refresh, loadMore, connection, lastUpdatedAt } = useApiTickets(ticketQuery);
  const [timings, setTimings] = useState<Record<string, TimingRecord>>({});
  const [liveMetrics, setLiveMetrics] = useState<Record<string, number>>({});
  const [detail, setDetail] = useState<TicketDetail>();
  const [managementError, setManagementError] = useState('');
  const [notifications, setNotifications] = useState<Array<{ id: string; type: string; readAt: string | null; sentAt: string }>>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [workforce, setWorkforce] = useState<Array<{
    id?: string;
    user: {
      id: string;
      name: string;
      email?: string;
      employeeCode?: string | null;
      status?: string;
      role?: string;
      approvalStatus?: string;
      requestedBy?: { name: string; employeeCode?: string | null } | null;
      rejectionReason?: string | null;
      createdAt?: string;
    };
    availability: string;
    capacity?: number;
    activeCount?: number;
    activeAssignmentCount?: number;
    pool: { id?: string; category: string; subtype: string; hallId?: string | null };
  }>>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Array<{
    id: string;
    employeeCode: string | null;
    name: string;
    email: string;
    approvalStatus: string;
    createdAt: string;
    requestedBy: { name: string; employeeCode?: string | null } | null;
    memberships: Array<{ pool: { category: string; subtype: string; hallId: string | null } }>;
  }>>([]);
  const [workforceFilter, setWorkforceFilter] = useState<'ALL' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED'>('ALL');
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [personFormError, setPersonFormError] = useState('');
  const [personSubmitting, setPersonSubmitting] = useState(false);
  const [personRole, setPersonRole] = useState<'STAFF' | 'HALL_MANAGER'>('STAFF');
  const [personHallId, setPersonHallId] = useState('');
  const [personServiceCategory, setPersonServiceCategory] = useState('HOUSE_HELP');
  const [masterForm, setMasterForm] = useState<'hall' | 'zone' | 'stall' | null>(null);
  const [masterFormError, setMasterFormError] = useState('');
  const [masterSubmitting, setMasterSubmitting] = useState(false);
  const [slaEditPoolId, setSlaEditPoolId] = useState<string | null>(null);
  const [slaFormError, setSlaFormError] = useState('');
  const [slaSubmitting, setSlaSubmitting] = useState(false);
  const [rejectUserId, setRejectUserId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState('');
  const [capacityEditUserId, setCapacityEditUserId] = useState<string | null>(null);
  const [capacityValue, setCapacityValue] = useState('1');
  const [activeSection, setActiveSection] = useState(navByRole[role][0]);
  const [exceptions, setExceptions] = useState<Ticket[]>([]);
  const [auditEvents, setAuditEvents] = useState<Array<{ id: string; eventType: string; createdAt: string; actor: { name: string } | null; ticket: { publicNo: string } }>>([]);
  const [masters, setMasters] = useState<Array<{
    id: string;
    name: string;
    timezone?: string;
    halls: Array<{ id: string; code: string; name: string; active?: boolean; zones: Array<{ id: string; code: string; stalls: Array<{ id: string; stallCode: string }> }> }>;
    pools: Array<{ id: string; category: string; subtype: string; hallId?: string | null; responseTargetSeconds: number; resolutionTargetSeconds: number; active: boolean }>;
  }>>([]);
  const [reportRange, setReportRange] = useState<'live' | 'today'>('live');
  const [exports, setExports] = useState<Array<{ id: string; format: string; status: string; rowCount: number | null; createdAt: string }>>([]);
  useAuthLoss(() => {
    setSelected(null);
    setTimings({});
    setLiveMetrics({});
    setDetail(undefined);
    setNotifications([]);
    setWorkforce([]);
    setPendingApprovals([]);
    setExceptions([]);
    setAuditEvents([]);
    setMasters([]);
    setExports([]);
  });
  const title = role === 'HALL_MANAGER' ? (profile?.scopes[0]?.hall?.name ?? 'Hall') + ' operations' : 'Event command center';
  const metrics = [
    { label: 'Open now', value: String(liveMetrics.open ?? '—') },
    { label: 'Queued', value: String(liveMetrics.queued ?? '—') },
    { label: 'Response overdue', value: String(liveMetrics.overdue ?? '—'), critical: true },
    { label: 'Escalated & complaints', value: liveMetrics.open == null && liveMetrics.queued == null ? '—' : String((liveMetrics.escalated ?? 0) + (liveMetrics.complaints ?? 0)), critical: true },
    { label: 'Closed today', value: String(liveMetrics.closedToday ?? '—') },
    { label: 'SLA breached', value: String(liveMetrics.slaBreached ?? '—'), critical: true },
    { label: 'Avg. response', value: duration(liveMetrics.avgResponseSeconds) },
  ];

  useEffect(() => {
    setSelected((current) => current ? items.find((ticket) => ticket.id === current.id) ?? null : items[0] ?? null);
  }, [items]);

  const loadManagement = useCallback(async () => {
    try {
      const metricsQuery = reportRange === 'today' ? '?range=today' : '';
      const [metricResponse, timingResponse] = await Promise.all([
      apiFetch('/api/management/metrics' + metricsQuery, { credentials: 'include', cache: 'no-store' }),
      apiFetch('/api/management/timing', { credentials: 'include', cache: 'no-store' }),
      ]);
      const errors: string[] = [];
      if (metricResponse.ok) {
        setLiveMetrics(await metricResponse.json() as Record<string, number>);
      } else {
        setLiveMetrics({});
        errors.push('Live metrics are unavailable');
      }
      if (timingResponse.ok) {
        const values = await timingResponse.json() as TimingRecord[];
        setTimings(Object.fromEntries(values.map((value) => [value.id, value])));
      } else {
        setTimings({});
        errors.push('Timing data is unavailable');
      }
      if (errors.length) setManagementError(errors.join('. '));
    } catch {
      setLiveMetrics({});
      setTimings({});
      setManagementError('Management APIs are unavailable');
    }
  }, [reportRange]);
  useEffect(() => { void loadManagement(); }, [loadManagement, lastUpdatedAt]);

  useEffect(() => {
    async function loadOperationalPanels() {
      const requests = [
        apiFetch('/api/workforce', { credentials: 'include', cache: 'no-store' }),
        apiFetch('/api/management/exceptions', { credentials: 'include', cache: 'no-store' }),
        apiFetch('/api/management/audit', { credentials: 'include', cache: 'no-store' }),
        ...(role === 'ADMIN' ? [apiFetch('/api/workforce/pending', { credentials: 'include', cache: 'no-store' })] : []),
      ];
      const responses = await Promise.all(requests);
      if (responses[0].ok) setWorkforce(await responses[0].json() as typeof workforce);
      if (responses[1].ok) setExceptions(((await responses[1].json()) as ApiTicket[]).map(mapTicket));
      if (responses[2].ok) setAuditEvents(await responses[2].json() as typeof auditEvents);
      if (role === 'ADMIN' && responses[3]?.ok) setPendingApprovals(await responses[3].json() as typeof pendingApprovals);
    }
    void loadOperationalPanels().catch(() => setManagementError('Operational panels could not be loaded'));
  }, [lastUpdatedAt, role]);

  async function refreshWorkforcePanels() {
    const list = await apiFetch('/api/workforce', { credentials: 'include', cache: 'no-store' });
    if (list.ok) setWorkforce(await list.json() as typeof workforce);
    if (role === 'ADMIN') {
      const pending = await apiFetch('/api/workforce/pending', { credentials: 'include', cache: 'no-store' });
      if (pending.ok) setPendingApprovals(await pending.json() as typeof pendingApprovals);
    }
  }
  useEffect(() => {
    if (role !== 'ADMIN') return;
    void Promise.all([
      apiFetch('/api/management/masters', { credentials: 'include', cache: 'no-store' }),
      apiFetch('/api/management/exports', { credentials: 'include', cache: 'no-store' }),
    ]).then(async ([mastersResponse, exportsResponse]) => {
      if (mastersResponse.ok) setMasters(await mastersResponse.json() as typeof masters);
      if (exportsResponse.ok) setExports(await exportsResponse.json() as typeof exports);
    }).catch(() => setManagementError('Administration data could not be loaded'));
  }, [role]);

  useEffect(() => {
    if (!showAddPerson || personHallId) return;
    const halls = role === 'ADMIN'
      ? masters.flatMap((event) => event.halls)
      : (profile?.scopes.flatMap((scope) => scope.hall ? [{ id: scope.hall.id }] : []) ?? []);
    if (halls[0]?.id) setPersonHallId(halls[0].id);
  }, [showAddPerson, personHallId, masters, profile, role]);

  useEffect(() => {
    if (!selected) { setDetail(undefined); return; }
    void apiFetch('/api/tickets/' + selected.id, { credentials: 'include', cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<TicketDetail> : undefined)
      .then(setDetail)
      .catch(() => setManagementError('Ticket detail could not be loaded'));
  }, [selected, lastUpdatedAt]);

  async function loadNotifications() {
    const response = await apiFetch('/api/notifications', { credentials: 'include', cache: 'no-store' });
    if (!response.ok) { setManagementError('Notifications could not be loaded'); return; }
    setNotifications(await response.json() as typeof notifications);
    setShowNotifications((value) => !value);
  }

  async function runTicketAction(path: string, body: object) {
    if (!selected) return;
    const response = await apiFetch('/api/tickets/' + selected.id + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) { setManagementError(await apiErrorMessage(response, 'Ticket action failed')); return false; }
    setManagementError('');
    await refresh();
    return true;
  }

  async function transitionSelected(to: TicketStatus, reason: string) {
    return runTicketAction('/transition', { to, reason });
  }

  async function reassignSelected(staffId: string, reason: string) {
    if (!selected) return false;
    const response = await apiFetch('/api/workforce/tickets/' + selected.id + '/reassign', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffId, reason }),
    });
    if (!response.ok) {
      setManagementError(await apiErrorMessage(response, 'Reassignment failed'));
      return false;
    }
    setManagementError('');
    await refresh();
    return true;
  }

  async function exportView() {
    const response = await apiFetch('/api/management/exports', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'CSV', filters: { status: statusFilter || undefined, category: categoryFilter || undefined, search: search || undefined }, columns: [] }),
    });
    setManagementError(response.ok ? 'Export queued. It will appear in Reports when ready.' : 'Export could not be queued');
  }

  async function createMaster(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!masterForm || masterSubmitting) return;
    const eventId = profile?.scopes[0]?.event.id;
    if (!eventId) {
      setMasterFormError('Event scope is required');
      return;
    }
    setMasterSubmitting(true);
    setMasterFormError('');
    const values = new FormData(event.currentTarget);
    const body: Record<string, unknown> = { eventId };
    if (masterForm === 'hall') {
      body.code = String(values.get('code') ?? '').trim();
      body.name = String(values.get('name') ?? '').trim();
      body.status = String(values.get('status') ?? 'ACTIVE');
    } else if (masterForm === 'zone') {
      body.hallId = String(values.get('hallId') ?? '');
      body.code = String(values.get('code') ?? '').trim();
    } else {
      body.zoneId = String(values.get('zoneId') ?? '');
      body.stallCode = String(values.get('stallCode') ?? '').trim();
      body.exhibitorName = String(values.get('exhibitorName') ?? '').trim();
      body.contact = String(values.get('contact') ?? '').trim() || undefined;
      body.active = String(values.get('active') ?? 'true') === 'true';
    }
    const response = await apiFetch('/api/management/masters/' + masterForm, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setMasterFormError(await apiErrorMessage(response, 'Master record could not be created'));
      setMasterSubmitting(false);
      return;
    }
    setMasterForm(null);
    setMasterSubmitting(false);
    setManagementError(`${masterForm[0].toUpperCase()}${masterForm.slice(1)} created.`);
    const mastersResponse = await apiFetch('/api/management/masters', { credentials: 'include', cache: 'no-store' });
    if (mastersResponse.ok) setMasters(await mastersResponse.json());
  }

  async function createPerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (personSubmitting) return;
    setPersonSubmitting(true);
    setPersonFormError('');
    const values = new FormData(event.currentTarget);
    const eventId = profile?.scopes[0]?.event.id;
    if (!eventId) {
      setPersonFormError('Event scope is required to create a person');
      setPersonSubmitting(false);
      return;
    }
    const createdRole = (role === 'HALL_MANAGER' ? 'STAFF' : String(values.get('role') ?? personRole ?? 'STAFF')) as 'STAFF' | 'HALL_MANAGER';
    const scopedHallIds = [...new Set((profile?.scopes ?? []).flatMap((scope) => scope.hall?.id ? [scope.hall.id] : []))];
    const scopedHallId = scopedHallIds[0];
    const hallId = String(values.get('hallId') ?? personHallId ?? scopedHallId ?? '').trim();
    if ((createdRole === 'STAFF' || createdRole === 'HALL_MANAGER') && !hallId) {
      setPersonFormError('Hall is required.');
      setPersonSubmitting(false);
      return;
    }
    if (role === 'HALL_MANAGER' && hallId && !scopedHallIds.includes(hallId)) {
      setPersonFormError('You can only create staff for your assigned hall.');
      setPersonSubmitting(false);
      return;
    }
    const password = String(values.get('password') ?? '');
    if (password.length < 10) {
      setPersonFormError('Temporary password must be at least 10 characters.');
      setPersonSubmitting(false);
      return;
    }
    if (createdRole === 'STAFF') {
      const serviceCategory = String(values.get('serviceCategory') ?? personServiceCategory ?? '');
      const serviceSubtype = String(values.get('serviceSubtype') ?? '');
      if (!serviceCategory || !serviceSubtype) {
        setPersonFormError('Service category and subtype are required for Service Staff.');
        setPersonSubmitting(false);
        return;
      }
    }
    const body: Record<string, unknown> = {
      name: String(values.get('name') ?? '').trim(),
      email: String(values.get('email') ?? '').trim().toLowerCase(),
      phone: String(values.get('phone') ?? '').trim() || undefined,
      password,
      role: createdRole,
      eventId,
      hallId,
      capacity: Number(values.get('capacity') || 1),
    };
    if (role === 'ADMIN') {
      const employeeCode = String(values.get('employeeCode') ?? '').trim().toUpperCase();
      if (employeeCode) body.employeeCode = employeeCode;
    }
    if (createdRole === 'STAFF') {
      body.serviceCategory = String(values.get('serviceCategory') ?? personServiceCategory);
      body.serviceSubtype = String(values.get('serviceSubtype') ?? '');
    }
    const response = await apiFetch('/api/workforce/people', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setPersonFormError(await apiErrorMessage(response, 'Person could not be created'));
      setPersonSubmitting(false);
      return;
    }
    const created = await response.json() as { approvalStatus?: string; name?: string; employeeCode?: string | null };
    setShowAddPerson(false);
    setPersonSubmitting(false);
    setPersonRole('STAFF');
    setPersonHallId('');
    setPersonServiceCategory('HOUSE_HELP');
    setManagementError(
      created.approvalStatus === 'PENDING_APPROVAL'
        ? `Staff ${created.name ?? String(body.name)} created and sent for Admin approval. Public person ID will be assigned on approval.`
        : `Created ${created.name ?? String(body.name)} (${created.employeeCode ?? 'no public ID'}). Temporary password must be changed on first sign-in.`,
    );
    await refreshWorkforcePanels();
  }

  async function approvePerson(userId: string) {
    const response = await apiFetch('/api/workforce/people/' + userId + '/approve', { method: 'POST', credentials: 'include' });
    if (!response.ok) {
      setManagementError(await apiErrorMessage(response, 'Approval failed'));
      return;
    }
    setManagementError('Staff approved and activated for routing when on duty.');
    await refreshWorkforcePanels();
  }

  async function rejectPerson(userId: string) {
    if (rejectUserId !== userId) {
      setRejectUserId(userId);
      setRejectReason('');
      setRejectError('');
      return;
    }
    if (rejectReason.trim().length < 3) {
      setRejectError('Rejection reason is required (at least 3 characters).');
      return;
    }
    const response = await apiFetch('/api/workforce/people/' + userId + '/reject', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: rejectReason.trim() }),
    });
    if (!response.ok) {
      setRejectError(await apiErrorMessage(response, 'Rejection failed'));
      return;
    }
    setRejectUserId(null);
    setRejectReason('');
    setRejectError('');
    setManagementError('Staff request rejected.');
    await refreshWorkforcePanels();
  }

  async function updatePersonStatus(userId: string, status: 'ACTIVE' | 'DISABLED') {
    const response = await apiFetch('/api/workforce/people/' + userId, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      setManagementError(await apiErrorMessage(response, 'Person status could not be updated'));
      return;
    }
    await refreshWorkforcePanels();
  }

  async function updatePersonCapacity(userId: string, capacity: number) {
    const response = await apiFetch('/api/workforce/people/' + userId, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacity }),
    });
    if (!response.ok) {
      setManagementError(await apiErrorMessage(response, 'Capacity could not be updated'));
      return;
    }
    setCapacityEditUserId(null);
    await refreshWorkforcePanels();
  }

  async function updatePool(event: FormEvent<HTMLFormElement>, pool: { id: string; active: boolean }) {
    event.preventDefault();
    if (slaSubmitting) return;
    setSlaSubmitting(true);
    setSlaFormError('');
    const values = new FormData(event.currentTarget);
    const responseTargetSeconds = Number(values.get('responseTargetSeconds'));
    const resolutionTargetSeconds = Number(values.get('resolutionTargetSeconds'));
    const response = await apiFetch('/api/management/masters/pools/' + pool.id, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responseTargetSeconds, resolutionTargetSeconds, active: pool.active }),
    });
    if (!response.ok) {
      setSlaFormError(await apiErrorMessage(response, 'Service pool could not be updated'));
      setSlaSubmitting(false);
      return;
    }
    setSlaEditPoolId(null);
    setSlaSubmitting(false);
    setManagementError('SLA targets updated.');
    const mastersResponse = await apiFetch('/api/management/masters', { credentials: 'include', cache: 'no-store' });
    if (mastersResponse.ok) setMasters(await mastersResponse.json());
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>E</span>EveOps</div>
        <nav aria-label={role === 'ADMIN' ? 'Admin navigation' : 'Hall Manager navigation'}>
          {navByRole[role].map((item) => <button className={activeSection === item ? 'active' : ''} onClick={() => setActiveSection(item)} key={item}>{item}{item === 'Live tickets' && <i>{liveMetrics.open ?? '—'}</i>}{item === 'Exceptions' && <i>{liveMetrics.open == null && liveMetrics.queued == null ? '—' : (liveMetrics.overdue ?? 0) + (liveMetrics.escalated ?? 0) + (liveMetrics.complaints ?? 0)}</i>}{(item === 'Workforce' || item === 'Staff') && role === 'ADMIN' && pendingApprovals.length > 0 && <i>{pendingApprovals.length}</i>}</button>)}
        </nav>
        <div className="user"><span>{role === 'ADMIN' ? 'AD' : 'HM'}</span><div><strong>{profile?.name ?? (role === 'ADMIN' ? 'Event Admin' : 'Hall Manager')}</strong><small>{role.replace('_', ' ')}</small></div></div>
        <LogoutButton />
      </aside>
      <main className="management">
        <header className="topbar"><div><span className="eyebrow">{profile?.scopes[0]?.event.name ?? 'EveOps event'} · {connection === 'live' ? 'Live' : 'Reconnecting'}</span><h1>{title}</h1></div><div className="top-actions"><span>{profile?.scopes[0]?.hall?.name ?? 'All scoped halls'}</span><button onClick={() => void loadNotifications()}>Notifications · {notifications.filter((notification) => !notification.readAt).length}</button></div></header>
        {managementError && <div className={managementError.startsWith('Export queued') || managementError.startsWith('Created ') || managementError.includes('sent for Admin approval') || managementError.startsWith('Staff approved') || managementError.startsWith('Staff request rejected') || managementError.endsWith('created.') || managementError.startsWith('SLA targets') || managementError.includes('Temporary password must be changed') || managementError.startsWith('Completion verified') ? 'alert-line' : 'form-error'} role="status">{managementError}</div>}
        {showNotifications && <section className="notification-panel">{notifications.length ? notifications.slice(0, 10).map((notification) => <button key={notification.id} onClick={() => void apiFetch('/api/notifications/' + notification.id + '/read', { method: 'PATCH', credentials: 'include' }).then(() => loadNotifications())}><strong>{notification.type.replaceAll('_', ' ')}</strong><span>{eventTime(notification.sentAt)}</span></button>) : <p className="empty-state">No notifications.</p>}</section>}
        <section className="metric-grid" aria-label="Operational metrics">{metrics.map((metric) => <article key={metric.label} className={metric.critical ? 'metric critical' : 'metric'}><span>{metric.label}</span><strong>{metric.value}</strong><small>Updated live</small></article>)}</section>
        {(activeSection === 'Staff' || activeSection === 'Workforce') && (() => {
          const visibleWorkforce = workforce.filter((membership) => workforceFilter === 'ALL' || membership.user.approvalStatus === workforceFilter);
          return <section className="portfolio-list"><div className="section-title"><div><h2>Workforce</h2><p>{role === 'HALL_MANAGER' ? 'Create Electrical or House Help staff for Admin approval. Ticket age is never edited here.' : 'Approve Hall Manager staff requests and manage event workforce identities.'}</p></div><div className="drawer-actions"><select aria-label="Approval filter" value={workforceFilter} onChange={(event) => setWorkforceFilter(event.target.value as typeof workforceFilter)}><option value="ALL">All</option><option value="PENDING_APPROVAL">Pending approval</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select><button onClick={() => { const next = !showAddPerson; setShowAddPerson(next); setPersonFormError(''); if (next) { setPersonRole('STAFF'); setPersonServiceCategory('HOUSE_HELP'); const halls = role === 'ADMIN' ? masters.flatMap((event) => event.halls).filter((hall) => hall.active !== false) : (profile?.scopes.flatMap((scope) => scope.hall ? [{ id: scope.hall.id, code: scope.hall.code, name: scope.hall.name }] : []) ?? []); setPersonHallId(halls[0]?.id ?? ''); if (role === 'ADMIN' && !masters.length) void apiFetch('/api/management/masters', { credentials: 'include', cache: 'no-store' }).then(async (response) => { if (response.ok) setMasters(await response.json() as typeof masters); }); } }}>{showAddPerson ? 'Close form' : (role === 'HALL_MANAGER' ? 'Add Staff' : 'Add person')}</button></div></div>{role === 'ADMIN' && !!pendingApprovals.length && <div className="portfolio-list"><div className="section-title"><div><h2>Pending approvals</h2><p>{pendingApprovals.length} awaiting review</p></div></div>{pendingApprovals.map((person) => <article key={person.id}><div><strong>{person.name}</strong><span>{person.employeeCode ?? 'No public ID'} · {person.memberships[0]?.pool.category ?? 'Staff'}</span></div><div><span>Requested by</span><strong>{person.requestedBy?.name ?? 'Hall Manager'}</strong></div><div><span>Created</span><strong>{eventTime(person.createdAt)}</strong></div><div className="drawer-actions"><button className="primary" type="button" onClick={() => void approvePerson(person.id)}>Approve</button><button className="critical-button" type="button" onClick={() => void rejectPerson(person.id)}>{rejectUserId === person.id ? 'Confirm reject' : 'Reject'}</button></div>{rejectUserId === person.id && <form className="authority-action" onSubmit={(event) => { event.preventDefault(); void rejectPerson(person.id); }}><label>Rejection reason<span aria-hidden="true"> *</span><input value={rejectReason} onChange={(change) => setRejectReason(change.target.value)} required minLength={3} /></label>{rejectError && <p className="form-error" role="alert">{rejectError}</p>}<div className="drawer-actions"><button type="button" onClick={() => { setRejectUserId(null); setRejectError(''); }}>Cancel</button><button className="critical-button" type="submit">Submit rejection</button></div></form>}</article>)}</div>}{showAddPerson && (() => {
            const adminHalls = masters.flatMap((event) => event.halls).filter((hall) => hall.active !== false);
            const hmHalls = profile?.scopes.flatMap((scope) => scope.hall ? [{ id: scope.hall.id, code: scope.hall.code, name: scope.hall.name }] : []) ?? [];
            const hallOptions = role === 'ADMIN' ? adminHalls : hmHalls;
            const selectedHallId = personHallId || hallOptions[0]?.id || '';
            const showStaffServiceFields = role === 'HALL_MANAGER' || personRole === 'STAFF';
            const poolSubtypes = masters
              .flatMap((event) => event.pools)
              .filter((pool) => pool.active !== false && pool.category === personServiceCategory && (!selectedHallId || !pool.hallId || pool.hallId === selectedHallId))
              .map((pool) => pool.subtype);
            const subtypeOptions = [...new Set(poolSubtypes.length ? poolSubtypes : (personServiceCategory === 'ELECTRICAL' ? ['Lighting', 'NCP', 'General'] : ['General']))];
            return <form className="authority-action" onSubmit={(event) => void createPerson(event)}>
              <label>Name<span aria-hidden="true"> *</span><input name="name" required minLength={2} autoComplete="name" /></label>
              <label>Login email<span aria-hidden="true"> *</span><input name="email" type="email" required autoComplete="username" /></label>
              <label>Phone<input name="phone" autoComplete="tel" /></label>
              <label>Temporary password<span aria-hidden="true"> *</span><input name="password" type="password" required minLength={10} autoComplete="new-password" /><span className="otp-hint">Must be changed on first sign-in.</span></label>
              {role === 'ADMIN' ? (
                <label>Public person ID (optional)<input name="employeeCode" placeholder="STF-00012" /><span className="otp-hint">Leave blank to auto-generate. Hall Managers cannot assign IDs.</span></label>
              ) : (
                <p className="otp-hint">Public person ID will be assigned by Admin on approval.</p>
              )}
              {role === 'ADMIN' ? (
                <label>Role<span aria-hidden="true"> *</span>
                  <select name="role" required value={personRole} onChange={(change) => setPersonRole(change.target.value as 'STAFF' | 'HALL_MANAGER')}>
                    <option value="STAFF">Service Staff</option>
                    <option value="HALL_MANAGER">Hall Manager</option>
                  </select>
                </label>
              ) : <input type="hidden" name="role" value="STAFF" />}
              {hallOptions.length === 0 ? (
                <p className="form-error" role="alert">No hall is available in your scope. Add a hall in Masters before creating staff.</p>
              ) : hallOptions.length === 1 && role === 'HALL_MANAGER' ? (
                <label>Hall<span aria-hidden="true"> *</span>
                  <input type="hidden" name="hallId" value={hallOptions[0].id} />
                  <input value={`${hallOptions[0].code} · ${hallOptions[0].name}`} readOnly aria-readonly="true" />
                </label>
              ) : (
                <label>Hall<span aria-hidden="true"> *</span>
                  <select name="hallId" required value={selectedHallId} onChange={(change) => setPersonHallId(change.target.value)}>
                    {hallOptions.map((hall) => <option key={hall.id} value={hall.id}>{hall.code} · {hall.name}</option>)}
                  </select>
                </label>
              )}
              {showStaffServiceFields && (
                <>
                  <label>Service category<span aria-hidden="true"> *</span>
                    <select name="serviceCategory" required value={personServiceCategory} onChange={(change) => setPersonServiceCategory(change.target.value)}>
                      <option value="ELECTRICAL">Electrical</option>
                      <option value="HOUSE_HELP">House Help</option>
                    </select>
                  </label>
                  <label>Service subtype<span aria-hidden="true"> *</span>
                    <select key={`${personServiceCategory}-${selectedHallId}`} name="serviceSubtype" required defaultValue={subtypeOptions[0]}>
                      {subtypeOptions.map((subtype) => <option key={subtype} value={subtype}>{subtype}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label>Capacity<span aria-hidden="true"> *</span><input name="capacity" type="number" min={1} max={20} defaultValue={1} required /></label>
              {role === 'HALL_MANAGER' && <p className="otp-hint">Approval: Pending Admin review after create. Staff cannot sign in or receive tickets until approved.</p>}
              {role === 'ADMIN' && <p className="otp-hint">Admin-created accounts are approved immediately. Share the temporary password securely.</p>}
              {personFormError && <p className="form-error" role="alert">{personFormError}</p>}
              <div className="drawer-actions">
                <button type="button" onClick={() => { setShowAddPerson(false); setPersonFormError(''); }}>Cancel</button>
                <button className="primary" type="submit" disabled={personSubmitting || hallOptions.length === 0}>{personSubmitting ? 'Creating…' : 'Create account'}</button>
              </div>
            </form>;
          })()}{visibleWorkforce.length ? visibleWorkforce.map((membership) => <article key={membership.user.id + membership.pool.category + membership.pool.subtype}><div><strong>{membership.user.name}</strong><span>{membership.user.employeeCode ?? 'No public ID'}{membership.user.email ? (' · ' + membership.user.email) : ''}</span></div><div><span>Service</span><strong>{membership.pool.category} · {membership.pool.subtype}</strong></div><div><span>Availability</span><strong>{membership.availability.replaceAll('_', ' ')}</strong></div><div><span>Load</span><strong>{membership.activeAssignmentCount ?? membership.activeCount ?? 0}/{membership.capacity ?? 1}</strong></div><div><span>Approval</span><strong>{(membership.user.approvalStatus ?? 'APPROVED').replaceAll('_', ' ')}</strong></div><div><span>Account</span><strong>{membership.user.status ?? 'ACTIVE'}</strong></div>{membership.user.rejectionReason && <div><span>Rejection</span><strong>{membership.user.rejectionReason}</strong></div>}{role === 'ADMIN' && membership.user.approvalStatus === 'PENDING_APPROVAL' && <div className="drawer-actions"><button className="primary" type="button" onClick={() => void approvePerson(membership.user.id)}>Approve</button><button className="critical-button" type="button" onClick={() => void rejectPerson(membership.user.id)}>{rejectUserId === membership.user.id ? 'Confirm reject' : 'Reject'}</button></div>}{rejectUserId === membership.user.id && <form className="authority-action" onSubmit={(event) => { event.preventDefault(); void rejectPerson(membership.user.id); }}><label>Rejection reason<span aria-hidden="true"> *</span><input value={rejectReason} onChange={(change) => setRejectReason(change.target.value)} required minLength={3} /></label>{rejectError && <p className="form-error" role="alert">{rejectError}</p>}<div className="drawer-actions"><button type="button" onClick={() => { setRejectUserId(null); setRejectError(''); }}>Cancel</button><button className="critical-button" type="submit">Submit rejection</button></div></form>}<div className="drawer-actions">{capacityEditUserId === membership.user.id ? <form className="authority-action" onSubmit={(event) => { event.preventDefault(); const nextCapacity = Number(capacityValue); if (Number.isInteger(nextCapacity) && nextCapacity >= 1) void updatePersonCapacity(membership.user.id, nextCapacity); }}><label>Capacity<span aria-hidden="true"> *</span><input type="number" min={1} max={20} value={capacityValue} onChange={(change) => setCapacityValue(change.target.value)} required /></label><div className="drawer-actions"><button type="button" onClick={() => setCapacityEditUserId(null)}>Cancel</button><button className="primary" type="submit">Save capacity</button></div></form> : <button type="button" onClick={() => { setCapacityEditUserId(membership.user.id); setCapacityValue(String(membership.capacity ?? 1)); }}>Edit capacity</button>}<button type="button" onClick={() => void updatePersonStatus(membership.user.id, membership.user.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED')}>{membership.user.status === 'DISABLED' ? 'Activate' : 'Deactivate'}</button></div></article>) : <p className="empty-state">No workforce identities match this filter.</p>}</section>;
        })()}
        {activeSection === 'Exceptions' && <section className="portfolio-list"><div className="section-title"><div><h2>Exception inbox</h2><p>Queued, overdue, complaint, reopened, and escalated tickets</p></div></div>{exceptions.length ? exceptions.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} />) : <p className="empty-state">No unresolved exceptions.</p>}</section>}
        {activeSection === 'Audit' && <section className="portfolio-list"><div className="section-title"><div><h2>Audit history</h2><p>Append-only scoped operational events</p></div></div>{auditEvents.map((event) => <article key={event.id}><div><strong>{event.ticket.publicNo}</strong><span>{event.actor?.name ?? 'System'}</span></div><div><span>Action</span><strong>{event.eventType.replaceAll('_', ' ')}</strong></div><div><span>Server time</span><strong>{eventTime(event.createdAt)}</strong></div></article>)}</section>}
        {(activeSection === 'Masters' || activeSection === 'Halls / Zones / Stalls') && <section className="portfolio-list"><div className="section-title"><div><h2>Event masters</h2><p>Authorized hierarchy and SLA configuration</p></div><div className="drawer-actions"><button type="button" onClick={() => { setMasterForm(masterForm === 'hall' ? null : 'hall'); setMasterFormError(''); }}>Add hall</button><button type="button" onClick={() => { setMasterForm(masterForm === 'zone' ? null : 'zone'); setMasterFormError(''); }}>Add zone</button><button type="button" onClick={() => { setMasterForm(masterForm === 'stall' ? null : 'stall'); setMasterFormError(''); }}>Add stall</button></div></div>
          {masterForm === 'hall' && <form className="authority-action" onSubmit={(event) => void createMaster(event)}><label>Hall code<span aria-hidden="true"> *</span><input name="code" required minLength={1} /></label><label>Hall name<span aria-hidden="true"> *</span><input name="name" required minLength={1} /></label><label>Status<select name="status" defaultValue="ACTIVE"><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>{masterFormError && <p className="form-error" role="alert">{masterFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setMasterForm(null)}>Cancel</button><button className="primary" type="submit" disabled={masterSubmitting}>{masterSubmitting ? 'Saving…' : 'Create hall'}</button></div></form>}
          {masterForm === 'zone' && <form className="authority-action" onSubmit={(event) => void createMaster(event)}><label>Hall<span aria-hidden="true"> *</span><select name="hallId" required>{masters.flatMap((event) => event.halls).map((hall) => <option key={hall.id} value={hall.id}>{hall.name}</option>)}</select></label><label>Zone code<span aria-hidden="true"> *</span><input name="code" required minLength={1} /></label>{masterFormError && <p className="form-error" role="alert">{masterFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setMasterForm(null)}>Cancel</button><button className="primary" type="submit" disabled={masterSubmitting}>{masterSubmitting ? 'Saving…' : 'Create zone'}</button></div></form>}
          {masterForm === 'stall' && <form className="authority-action" onSubmit={(event) => void createMaster(event)}><label>Zone<span aria-hidden="true"> *</span><select name="zoneId" required>{masters.flatMap((event) => event.halls.flatMap((hall) => hall.zones.map((zone) => <option key={zone.id} value={zone.id}>{hall.name} · {zone.code}</option>)))}</select></label><label>Stall code<span aria-hidden="true"> *</span><input name="stallCode" required minLength={1} /></label><label>Exhibitor<span aria-hidden="true"> *</span><input name="exhibitorName" required minLength={1} /></label><label>Contact<input name="contact" /></label><label>Active<select name="active" defaultValue="true"><option value="true">Active</option><option value="false">Inactive</option></select></label>{masterFormError && <p className="form-error" role="alert">{masterFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setMasterForm(null)}>Cancel</button><button className="primary" type="submit" disabled={masterSubmitting}>{masterSubmitting ? 'Saving…' : 'Create stall'}</button></div></form>}
          {!masters.length ? <p className="empty-state">No master hierarchy is available for your event scope.</p> : masters.map((event) => <div key={event.id}><article><div><strong>{event.name}</strong><span>{event.timezone ? `Timezone ${event.timezone}` : 'Event masters'}</span></div><div><span>Halls</span><strong>{event.halls.length}</strong></div><div><span>Zones</span><strong>{event.halls.reduce((sum, hall) => sum + hall.zones.length, 0)}</strong></div><div><span>Stalls</span><strong>{event.halls.reduce((sum, hall) => sum + hall.zones.reduce((zoneSum, zone) => zoneSum + zone.stalls.length, 0), 0)}</strong></div></article>{event.halls.map((hall) => <article key={hall.id}><div><strong>{hall.name}</strong><span>{hall.zones.length} zones · {hall.zones.reduce((sum, zone) => sum + zone.stalls.length, 0)} stalls</span></div><div><span>Zones</span><strong>{hall.zones.map((zone) => zone.code).join(', ') || 'None'}</strong></div><div><span>Stalls</span><strong>{hall.zones.flatMap((zone) => zone.stalls.map((stall) => stall.stallCode)).join(', ') || 'None'}</strong></div></article>)}{event.pools.map((pool) => <article key={pool.id}><div><strong>{pool.category} · {pool.subtype}</strong><span>{pool.active ? 'Active' : 'Inactive'}</span></div><div><span>Response SLA</span><strong>{duration(pool.responseTargetSeconds)}</strong></div><div><span>Resolution SLA</span><strong>{duration(pool.resolutionTargetSeconds)}</strong></div>{slaEditPoolId === pool.id ? <form className="authority-action" onSubmit={(formEvent) => void updatePool(formEvent, pool)}><label>Response target (seconds)<span aria-hidden="true"> *</span><input name="responseTargetSeconds" type="number" min={1} required defaultValue={pool.responseTargetSeconds} /></label><label>Resolution target (seconds)<span aria-hidden="true"> *</span><input name="resolutionTargetSeconds" type="number" min={1} required defaultValue={pool.resolutionTargetSeconds} /></label>{slaFormError && <p className="form-error" role="alert">{slaFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setSlaEditPoolId(null)}>Cancel</button><button className="primary" type="submit" disabled={slaSubmitting}>{slaSubmitting ? 'Saving…' : 'Save SLA'}</button></div></form> : <button type="button" onClick={() => { setSlaEditPoolId(pool.id); setSlaFormError(''); }}>Edit SLA</button>}</article>)}</div>)}</section>}
        {(activeSection === 'Reports') && <section className="portfolio-list"><div className="section-title"><div><h2>Reports</h2><p>Operational metrics for the selected range, plus authorized CSV export jobs</p></div><div className="drawer-actions"><label className="sr-only" htmlFor="report-range">Report range</label><select id="report-range" aria-label="Report range" value={reportRange} onChange={(event) => setReportRange(event.target.value as 'live' | 'today')}><option value="live">Event live (open + recent)</option><option value="today">Created today</option></select><button type="button" onClick={() => void exportView()}>Queue CSV export</button></div></div><div className="metric-grid" aria-label="Report metrics"><article className="metric"><span>Open now</span><strong>{liveMetrics.open ?? '—'}</strong></article><article className="metric"><span>Closed today</span><strong>{liveMetrics.closedToday ?? '—'}</strong></article><article className="metric"><span>Avg. response</span><strong>{duration(liveMetrics.avgResponseSeconds)}</strong></article><article className="metric critical"><span>SLA breached</span><strong>{liveMetrics.slaBreached ?? '—'}</strong></article><article className="metric critical"><span>Complaints</span><strong>{liveMetrics.complaints ?? '—'}</strong></article><article className="metric"><span>Queued</span><strong>{liveMetrics.queued ?? '—'}</strong></article></div>{exports.length ? exports.map((job) => <article key={job.id}><div><strong>{job.format}</strong><span>{eventTime(job.createdAt)}</span></div><div><span>Status</span><strong>{job.status}</strong></div><div><span>Rows</span><strong>{job.rowCount ?? 'Pending'}</strong></div>{job.status === 'READY' && <a href={'/api/management/exports/' + job.id + '/download'}>Download</a>}</article>) : <p className="empty-state">No export jobs yet. Queue an export from Live operations or Reports.</p>}</section>}
        <section className="workspace">
          <div className="operations">
            <div className="section-title"><div><h2>Live operations</h2><p>{total} scoped tickets · server-authoritative status</p></div>{role === 'ADMIN' && <button onClick={() => void exportView()}>Export view</button>}</div>
            <div className="filters"><select aria-label="Status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option>{Object.keys(statusLabels).map((status) => <option key={status} value={status}>{statusLabels[status as TicketStatus]}</option>)}</select><select aria-label="Service filter" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All services</option><option value="ELECTRICAL">Electrical</option><option value="HOUSE_HELP">House Help</option><option value="HALL_MANAGER">Hall Manager</option></select><label className="sr-only" htmlFor="ticket-search">Search tickets</label><input id="ticket-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search ticket or stall" /></div>
            {loading ? <p className="empty-state">Loading live operations…</p> : loadError ? <p className="form-error">{loadError}</p> : !items.length ? <p className="empty-state">No tickets match the current scope. Clear filters to see all tickets.</p> : <><div className="table-wrap"><table><thead><tr><th>Ticket</th><th>Location / issue</th><th>Status</th><th>Age</th><th>Assignee</th><th>SLA</th></tr></thead><tbody>{items.map((ticket) => <tr key={ticket.no} tabIndex={0} className={selected?.no === ticket.no ? 'selected' : ''} onClick={() => setSelected(ticket)} onKeyDown={(event) => { if (event.key === 'Enter') setSelected(ticket); }}><td><strong>{ticket.no}</strong><small>{ticket.service}</small></td><td><strong>{ticket.location}</strong><small>{ticket.description}</small></td><td><Status value={ticket.status} /></td><td className={ticket.priority ? 'red' : ''}>{ticket.age}</td><td>{ticket.assignee}</td><td><span className={ticket.slaState === 'On track' ? 'sla' : 'sla breach'}>{ticket.slaState}</span></td></tr>)}</tbody></table></div>{nextCursor && <button onClick={() => void loadMore()}>Load more</button>}</>}
          </div>
          {selected && <TicketDrawer ticket={selected} timing={timings[selected.id]} detail={detail} canAdmin={role === 'ADMIN'} canEmergencyClose={selected.capabilities.emergencyClose} canAdvance={selected.capabilities.advanceHallManagerWork} canVerifyOtp={!!selected.capabilities.verifyStallOtp} eligibleStaff={workforce.filter((membership) => membership.availability === 'ON_DUTY' && (membership.user.approvalStatus ?? 'APPROVED') === 'APPROVED' && membership.user.status !== 'DISABLED')} onAdvance={() => void runTicketAction('/transition', { to: selected.status === 'ACCEPTED' ? 'IN_PROGRESS' : selected.status === 'IN_PROGRESS' ? 'AWAITING_OTP' : 'ACCEPTED' })} onPing={(message) => runTicketAction('/ping', { message })} onReassign={reassignSelected} onReopen={(reason) => transitionSelected('REOPENED', reason)} onEscalate={(reason) => transitionSelected('ESCALATED', reason)} onPrioritize={(reason) => runTicketAction('/prioritize', { reason })} onCancel={(reason) => transitionSelected('CANCELLED', reason)} onOverrideClose={(reason) => runTicketAction('/override-close', { reason })} onVerifyOtp={async (otp) => {
            const response = await apiFetch('/api/tickets/' + selected.id + '/otp/verify', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ otp }),
            });
            if (!response.ok) {
              setManagementError(await apiErrorMessage(response, 'Could not verify the completion code'));
              return false;
            }
            setManagementError('Completion verified. Ticket closed.');
            await refresh();
            return true;
          }} />}
        </section>
      </main>
    </div>
  );
}

type PortfolioEvent = { id: string; event: string; venue: string; open: number; exceptions: number; avgResponseSeconds: number | null; medianResponseSeconds: number | null; portfolioMedianResponseSeconds: number | null };

export function SuperAdminWorkspace() {
  const profile = useProfile();
  const [activeSection, setActiveSection] = useState('Portfolio overview');
  const [portfolio, setPortfolio] = useState<PortfolioEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedEvent, setSelectedEvent] = useState('');
  const [admins, setAdmins] = useState<Array<{ id: string; name: string; email: string; status: string; scopes: Array<{ event: { name: string } }> }>>([]);
  const [governanceAudit, setGovernanceAudit] = useState<Array<{ id: string; eventType: string; createdAt: string; ticket: { publicNo: string }; actor: { name: string } | null }>>([]);
  const [governanceExports, setGovernanceExports] = useState<Array<{ id: string; format: string; status: string; rowCount: number | null; createdAt: string }>>([]);
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [adminFormError, setAdminFormError] = useState('');
  const [adminSubmitting, setAdminSubmitting] = useState(false);
  useAuthLoss(() => {
    setPortfolio([]);
    setAdmins([]);
    setGovernanceAudit([]);
    setGovernanceExports([]);
    setSelectedEvent('');
  });
  const { items: eventTickets, total: eventTicketTotal } = useApiTickets(selectedEvent ? 'eventId=' + encodeURIComponent(selectedEvent) + '&view=all' : 'view=all&limit=20');
  useEffect(() => {
    void apiFetch('/api/management/portfolio', { credentials: 'include', cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Portfolio could not be loaded');
        return response.json() as Promise<PortfolioEvent[]>;
      })
      .then((values: PortfolioEvent[]) => setPortfolio(values))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Portfolio could not be loaded'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    void Promise.all([
      apiFetch('/api/management/admins', { credentials: 'include', cache: 'no-store' }),
      apiFetch('/api/management/audit', { credentials: 'include', cache: 'no-store' }),
      apiFetch('/api/management/exports', { credentials: 'include', cache: 'no-store' }),
    ]).then(async ([adminResponse, auditResponse, exportResponse]) => {
      if (adminResponse.ok) setAdmins(await adminResponse.json() as typeof admins);
      if (auditResponse.ok) setGovernanceAudit(await auditResponse.json() as typeof governanceAudit);
      if (exportResponse.ok) setGovernanceExports(await exportResponse.json() as typeof governanceExports);
    }).catch(() => setError('Governance data could not be loaded'));
  }, []);
  const totalOpen = portfolio.reduce((sum, event) => sum + event.open, 0);
  const totalExceptions = portfolio.reduce((sum, event) => sum + event.exceptions, 0);
  const medianResponse = portfolio[0]?.portfolioMedianResponseSeconds == null ? '—' : duration(portfolio[0].portfolioMedianResponseSeconds);
  async function exportPortfolio() {
    const response = await apiFetch('/api/management/exports', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'CSV', filters: selectedEvent ? { eventId: selectedEvent } : {}, columns: [] }),
    });
    setError(response.ok ? 'Portfolio export queued.' : 'Portfolio export could not be queued.');
  }
  async function createAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adminSubmitting) return;
    setAdminSubmitting(true);
    setAdminFormError('');
    const values = new FormData(event.currentTarget);
    const eventIds = String(values.get('eventIds') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const response = await apiFetch('/api/management/admins', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: String(values.get('name') ?? '').trim(),
        email: String(values.get('email') ?? '').trim().toLowerCase(),
        password: String(values.get('password') ?? ''),
        eventIds,
      }),
    });
    if (!response.ok) {
      setAdminFormError(await apiErrorMessage(response, 'Admin account could not be created'));
      setAdminSubmitting(false);
      return;
    }
    setShowAddAdmin(false);
    setAdminSubmitting(false);
    setError('Admin account created. Temporary password must be changed on first sign-in.');
    const adminResponse = await apiFetch('/api/management/admins', { credentials: 'include', cache: 'no-store' });
    if (adminResponse.ok) setAdmins(await adminResponse.json() as typeof admins);
  }
  return (
    <div className="app-shell super-shell">
      <aside className="sidebar">
        <div className="brand"><span>E</span>EveOps</div>
        <nav aria-label="SuperAdmin navigation">{['Portfolio overview', 'Events', 'Tickets', 'Analytics', 'Exports', 'Configuration', 'Admins', 'Audit'].map((item) => <button className={activeSection === item ? 'active' : ''} onClick={() => setActiveSection(item)} key={item}>{item}</button>)}</nav>
        <div className="user"><span>SA</span><div><strong>{profile?.name ?? 'Organization owner'}</strong><small>SUPER ADMIN</small></div></div>
        <LogoutButton />
      </aside>
      <main className="management">
        <header className="topbar"><div><span className="eyebrow">Organization governance</span><h1>Portfolio overview</h1></div><div className="top-actions"><select aria-label="Event" value={selectedEvent} onChange={(event) => setSelectedEvent(event.target.value)}><option value="">All authorized events</option>{portfolio.map((event) => <option key={event.id} value={event.id}>{event.event}</option>)}</select><button>Exceptions · {totalExceptions}</button></div></header>
        {error && <div className={error.endsWith('queued.') ? 'alert-line' : 'form-error'}>{error}</div>}
        <section className="portfolio-hero"><div><span>Authorized events</span><strong>{portfolio.length}</strong></div><div><span>Open tickets</span><strong>{totalOpen}</strong></div><div><span>Cross-event exceptions</span><strong className="red">{totalExceptions}</strong></div><div><span>Median response</span><strong>{medianResponse}</strong></div></section>
        <section className="portfolio-list"><div className="section-title"><div><h2>Event performance</h2><p>Cross-event operational comparison</p></div><button onClick={() => void exportPortfolio()}>Export portfolio</button></div>{loading ? <p className="empty-state">Loading authorized events…</p> : portfolio.length ? portfolio.map((event) => <article key={event.id}><div><strong>{event.event}</strong><span>{event.venue}</span></div><div><span>Open</span><strong>{event.open}</strong></div><div><span>Exceptions</span><strong className="red">{event.exceptions}</strong></div><div><span>Avg. response</span><strong>{duration(event.avgResponseSeconds)}</strong></div><button onClick={() => setSelectedEvent(event.id)}>Open event</button></article>) : <p className="empty-state">No events are assigned to this governance account.</p>}</section>
        <section className="portfolio-list"><div className="section-title"><div><h2>{selectedEvent ? 'Selected event tickets' : 'Cross-event ticket explorer'}</h2><p>{eventTicketTotal} authorized tickets</p></div></div>{eventTickets.slice(0, 20).map((ticket) => <article key={ticket.id}><div><strong>{ticket.no}</strong><span>{ticket.location}</span></div><div><span>Status</span><Status value={ticket.status} /></div><div><span>Service</span><strong>{ticket.service}</strong></div><div><span>Age</span><strong>{ticket.age}</strong></div></article>)}</section>
        {activeSection === 'Admins' && <section className="portfolio-list"><div className="section-title"><div><h2>Organization admins</h2><p>Event-scoped operational administrators</p></div><button type="button" onClick={() => { setShowAddAdmin((value) => !value); setAdminFormError(''); }}>{showAddAdmin ? 'Close form' : 'Add admin'}</button></div>{showAddAdmin && <form className="authority-action" onSubmit={(event) => void createAdmin(event)}><label>Name<span aria-hidden="true"> *</span><input name="name" required minLength={2} /></label><label>Email<span aria-hidden="true"> *</span><input name="email" type="email" required /></label><label>Temporary password<span aria-hidden="true"> *</span><input name="password" type="password" required minLength={12} /></label><label>Authorized event IDs (comma separated)<span aria-hidden="true"> *</span><input name="eventIds" required defaultValue={selectedEvent || portfolio.map((event) => event.id).join(',')} /></label>{adminFormError && <p className="form-error" role="alert">{adminFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setShowAddAdmin(false)}>Cancel</button><button className="primary" type="submit" disabled={adminSubmitting}>{adminSubmitting ? 'Creating…' : 'Create admin'}</button></div></form>}{admins.length ? admins.map((admin) => <article key={admin.id}><div><strong>{admin.name}</strong><span>{admin.email}</span></div><div><span>Status</span><strong>{admin.status}</strong></div><div><span>Events</span><strong>{admin.scopes.map((scope) => scope.event.name).join(', ')}</strong></div></article>) : <p className="empty-state">No organization admins yet.</p>}</section>}
        {activeSection === 'Audit' && <section className="portfolio-list"><div className="section-title"><div><h2>Cross-event audit</h2><p>Immutable ticket lifecycle activity</p></div></div>{governanceAudit.map((event) => <article key={event.id}><div><strong>{event.ticket.publicNo}</strong><span>{event.actor?.name ?? 'System'}</span></div><div><span>Action</span><strong>{event.eventType.replaceAll('_', ' ')}</strong></div><div><span>Time</span><strong>{eventTime(event.createdAt)}</strong></div></article>)}</section>}
        {activeSection === 'Exports' && <section className="portfolio-list"><div className="section-title"><div><h2>Export center</h2><p>Authorized cross-event reports</p></div></div>{governanceExports.map((job) => <article key={job.id}><div><strong>{job.format}</strong><span>{eventTime(job.createdAt)}</span></div><div><span>Status</span><strong>{job.status}</strong></div><div><span>Rows</span><strong>{job.rowCount ?? 'Pending'}</strong></div>{job.status === 'READY' && <a href={'/api/management/exports/' + job.id + '/download'}>Download</a>}</article>)}</section>}
      </main>
    </div>
  );
}
