'use client';

import type { Role, TicketStatus } from '@eveops/contracts';
import { FormEvent, KeyboardEvent, ClipboardEvent, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { describeTicketTiming, managerAttentionLabel, shouldRefreshForTicketEvent } from '@eveops/ticket-timing';
import { apiFetch, apiErrorMessage, AUTH_LOST_EVENT, subscribeRealtime } from '../lib/api-client';
import { activitySentence, serviceLabel } from '../lib/activity-copy';
import { noteServerTime, ServerClockProvider, useOperationalNow } from '../lib/server-clock';
import { clearPushForLogout, releaseWorkAlerts } from '../lib/work-alerts';
import { WorkAlertHost } from './work-alerts';

type Ticket = {
  id: string;
  no: string;
  service: string;
  location: string;
  locationParts: { hall: string; zone: string; stall: string };
  status: TicketStatus;
  assignee: string;
  ownerId?: string;
  description: string;
  priority?: boolean;
  servicePriority?: 'HIGH' | 'MEDIUM' | 'LOW';
  createdAt: string;
  firstStartedAt?: string | null;
  completionRequestedAt?: string | null;
  closedAt?: string | null;
  reopenCount: number;
  complaintRaisedAt?: string | null;
  currentCycleStartedAt?: string | null;
  cancelledAt?: string | null;
  progressLabel?: string;
  slaState: 'On track' | 'Response overdue' | 'SLA breached';
  queuePriorityOverrideAt?: string | null;
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
  priority?: 'NORMAL' | 'URGENT';
  servicePriority?: 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  createdAt: string;
  firstAcceptedAt?: string | null;
  firstAssignedAt?: string | null;
  firstStartedAt?: string | null;
  completionRequestedAt?: string | null;
  closedAt?: string | null;
  reopenCount?: number;
  complaintRaisedAt?: string | null;
  currentCycleStartedAt?: string | null;
  cancelledAt?: string | null;
  pool?: { responseTargetSeconds: number; resolutionTargetSeconds: number } | null;
  hall: { code: string; name?: string };
  zone?: { code: string };
  stall: { stallCode: string };
  assignments?: Array<{ status: string; staff: { name: string } }>;
  progressLabel?: string;
  currentAssignee?: { id: string; name: string } | null;
  lastAssignee?: { id: string; name: string } | null;
  queueState?: 'QUEUED' | 'ASSIGNED' | 'NONE';
  nextAction: 'NONE' | 'WAIT_FOR_ASSIGNMENT' | 'VERIFY_OTP' | 'WAIT_FOR_OTP_VERIFICATION' | 'STAFF_VERIFY_OTP' | 'STALL_VERIFY_OTP' | 'ASSIGNEE_ACTION' | 'ROUTE';
  slaState?: 'ON_TRACK' | 'RESPONSE_OVERDUE' | 'SLA_BREACHED';
  queuePriorityOverrideAt?: string | null;
  capabilities: {
    advanceHallManagerWork: boolean;
    verifyStallOtp?: boolean;
    emergencyClose: boolean;
  };
};

const EventZoneContext = createContext('UTC');

function OperationalClock({ children, timeZone }: { children: ReactNode; timeZone?: string | null }) {
  return (
    <ServerClockProvider>
      <EventZoneContext.Provider value={timeZone || 'UTC'}>{children}</EventZoneContext.Provider>
    </ServerClockProvider>
  );
}

function TimingFacts({ ticket }: { ticket: Ticket }) {
  const nowMs = useOperationalNow();
  const timeZone = useContext(EventZoneContext);
  const timing = describeTicketTiming({
    status: ticket.status,
    createdAt: ticket.createdAt,
    closedAt: ticket.closedAt,
    reopenCount: ticket.reopenCount,
    complaintRaisedAt: ticket.complaintRaisedAt,
    currentCycleStartedAt: ticket.currentCycleStartedAt,
    cancelledAt: ticket.cancelledAt,
    completionRequestedAt: ticket.completionRequestedAt,
  }, nowMs);
  return (
    <>
      {timing.facts.map((fact) => (
        <span key={fact.label}>{fact.label} <strong>{fact.value}</strong></span>
      ))}
      {ticket.status === 'CLOSED' && ticket.closedAt ? <span>Closed <strong>{eventTime(ticket.closedAt, timeZone)}</strong></span> : null}
    </>
  );
}

function mapTicket(ticket: ApiTicket): Ticket {
  const hall = ticket.hall.name || ticket.hall.code;
  const zone = ticket.zone?.code ?? '';
  const stall = ticket.stall.stallCode;
  return {
    id: ticket.id,
    no: ticket.publicNo,
    service: serviceLabel(ticket.category) + ' · ' + ticket.subtype,
    location: [hall, zone, stall].filter(Boolean).join(' · '),
    locationParts: { hall, zone, stall },
    status: ticket.status,
    assignee: ticket.currentAssignee?.name
      ?? ticket.lastAssignee?.name
      ?? ticket.assignments?.[0]?.staff.name
      ?? (ticket.status === 'CLOSED' || ticket.status === 'CANCELLED' ? 'No assignee on record' : undefined)
      ?? (ticket.queueState === 'QUEUED' || ticket.status === 'QUEUED' ? 'Waiting in the queue' : 'Not currently assigned'),
    progressLabel: ticket.progressLabel,
    ownerId: ticket.currentAssignee?.id,
    description: ticket.description,
    priority: ticket.priority === 'URGENT',
    servicePriority: ticket.servicePriority,
    createdAt: ticket.createdAt,
    firstStartedAt: ticket.firstStartedAt,
    completionRequestedAt: ticket.completionRequestedAt,
    closedAt: ticket.closedAt,
    reopenCount: ticket.reopenCount ?? 0,
    complaintRaisedAt: ticket.complaintRaisedAt,
    currentCycleStartedAt: ticket.currentCycleStartedAt,
    cancelledAt: ticket.cancelledAt,
    slaState: ticket.slaState === 'SLA_BREACHED' ? 'SLA breached' : ticket.slaState === 'RESPONSE_OVERDUE' ? 'Response overdue' : 'On track',
    queuePriorityOverrideAt: ticket.queuePriorityOverrideAt ?? null,
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
  const loadedQuery = useRef('');
  const depthRef = useRef(1);
  const queryRef = useRef(query);
  if (queryRef.current !== query) {
    queryRef.current = query;
    depthRef.current = 1;
  }
  const refresh = useCallback(async (cursor?: string, append = false) => {
    const sequence = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (!append && loadedQuery.current !== query) setLoading(true);
    try {
      const collected: Ticket[] = [];
      let pageCursor = append ? cursor : undefined;
      let total = 0;
      let next: string | null = null;
      const pages = append ? 1 : Math.max(1, depthRef.current);
      let fetchedPages = 0;
      for (let page = 0; page < pages; page += 1) {
        const parameters = new URLSearchParams(query);
        if (pageCursor) parameters.set('cursor', pageCursor);
        const response = await apiFetch('/api/tickets?' + parameters.toString(), { credentials: 'include', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Live tickets could not be loaded');
        const receivedAt = Date.now();
        const result = await response.json() as { items: ApiTicket[]; total: number; nextCursor: string | null; serverTime?: string };
        if (sequence !== requestSequence.current) return;
        if (result.serverTime) noteServerTime(result.serverTime, receivedAt);
        collected.push(...result.items.map(mapTicket));
        total = result.total;
        next = result.nextCursor;
        fetchedPages += 1;
        if (!next) break;
        pageCursor = next;
      }
      if (sequence !== requestSequence.current) return;
      setItems((current) => append ? [...current, ...collected] : collected);
      setTotal(total);
      setNextCursor(next);
      depthRef.current = append ? depthRef.current + 1 : fetchedPages;
      setLastUpdatedAt(Date.now());
      setError('');
      loadedQuery.current = query;
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
        if (!shouldRefreshForTicketEvent(seenTicketVersions.current, data)) return;
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
  email?: string | null;
  phone?: string | null;
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
  if (audience === 'staff') {
    if (value === 'ASSIGNED') return 'New task';
    if (value === 'ACCEPTED') return 'Accepted — go to stall';
    if (value === 'IN_PROGRESS') return 'Work in progress';
    if (value === 'AWAITING_OTP') return "Waiting for stall's code";
    if (value === 'SNOOZED') return 'Respond in 10 min';
    if (value === 'REOPENED') return 'Task opened again';
    if (value === 'CLOSED') return 'Completed';
  }
  if (audience === 'stall') {
    if (value === 'NEW') return 'Request received';
    if (value === 'QUEUED') return 'Waiting for assistance';
    if (value === 'ASSIGNED' || value === 'SNOOZED') return 'Staff assigned';
    if (value === 'ACCEPTED') return 'Request accepted';
    if (value === 'IN_PROGRESS') return 'Work in progress';
    if (value === 'AWAITING_OTP') return 'Check the work and share your completion code';
    if (value === 'CLOSED') return 'Completed';
    if (value === 'COMPLAINT_RAISED') return 'Problem reported';
    if (value === 'REOPENED') return 'Request reopened';
    if (value === 'ESCALATED') return 'Manager reviewing your request';
    if (value === 'CANCELLED') return 'Cancelled';
  }
  if (value === 'AWAITING_OTP') return 'Awaiting OTP';
  return statusLabels[value];
}

function Status({ value, audience = 'manager' }: { value: TicketStatus; audience?: 'stall' | 'staff' | 'manager' }) {
  const appearance = audience === 'stall' && value === 'SNOOZED' ? 'ASSIGNED' : value;
  return <span className={'status status-' + appearance.toLowerCase()}>{statusLabelFor(value, audience)}</span>;
}

function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await clearPushForLogout();
    releaseWorkAlerts();
    await globalThis.fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.replace('/login');
    router.refresh();
  }
  return <button className="logout" onClick={logout}>Sign out</button>;
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
        {success ? 'Ticket completed' : submitting ? 'Verifying code…' : 'Verify code'}
      </button>
      <p className="otp-hint">Only enter the code after the stall confirms the work is complete.</p>
    </div>
  );
}

function TicketCard({ ticket, actions = false, actionLabel = 'Accept assignment', actionDisabled = false, onAccept, onSnooze, audience = 'manager', loadingLabel, showMilestones = false }: {
  ticket: Ticket;
  actions?: boolean;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAccept?: () => void;
  onSnooze?: () => void;
  audience?: 'stall' | 'staff' | 'manager';
  loadingLabel?: string;
  showMilestones?: boolean;
}) {
  const closed = ['CLOSED', 'CANCELLED'].includes(ticket.status);
  return (
    <article className="ticket-card">
      <div className="ticket-top"><span className="ticket-no">{ticket.no}</span><Status value={ticket.status} audience={audience} /></div>
      {audience === 'staff' && <p className="stall-hero">Stall {ticket.locationParts.stall}</p>}
      {audience === 'staff' && <p className="where-line">{ticket.locationParts.hall} · Zone {ticket.locationParts.zone}</p>}
      <h3>{ticket.service}</h3>
      <p className="description">{ticket.description}</p>
      {audience !== 'staff' && <div className="location location-emphasis">
        <span>{ticket.locationParts.hall} · {ticket.locationParts.zone}</span>
        <strong>Stall {ticket.locationParts.stall}</strong>
      </div>}
      {audience === 'manager' && (
        <div className="ticket-meta">
          <TimingFacts ticket={ticket} />
          <span>{closed ? 'Last handled by' : 'Handled by'} <strong>{ticket.assignee}</strong></span>
        </div>
      )}
      {audience === 'stall' && showMilestones && (
        <div className="ticket-meta">
          <span>Raised <strong>{eventTime(ticket.createdAt)}</strong></span>
          {ticket.status === 'CLOSED' && ticket.closedAt ? <span>Completed <strong>{eventTime(ticket.closedAt)}</strong></span> : null}
          {ticket.cancelledAt ? <span>Cancelled <strong>{eventTime(ticket.cancelledAt)}</strong></span> : null}
          {ticket.complaintRaisedAt ? <span>Problem reported <strong>{eventTime(ticket.complaintRaisedAt)}</strong></span> : null}
          {ticket.reopenCount > 0 ? <span>Reopened <strong>{ticket.reopenCount === 1 ? 'Once' : `${ticket.reopenCount} times`}</strong></span> : null}
        </div>
      )}
      {actions && (
        <div className="ticket-actions">
          <button className="primary" disabled={actionDisabled} onClick={onAccept}>{actionDisabled && loadingLabel ? loadingLabel : actionLabel}</button>
          {ticket.status === 'ASSIGNED' && <button disabled={actionDisabled} onClick={onSnooze}>10 min later</button>}
          {ticket.status === 'ASSIGNED' && audience === 'staff' && <p className="otp-hint">You can delay once. The task stays yours.</p>}
        </div>
      )}
    </article>
  );
}

function TicketActivity({ ticketId }: { ticketId: string }) {
  const [items, setItems] = useState<Array<{ id: string; eventType?: string; createdAt: string; actorName?: string; summary?: string }>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (next?: string) => {
    setLoading(true);
    setError('');
    const response = await apiFetch('/api/tickets/' + ticketId + '/activity' + (next ? '?cursor=' + encodeURIComponent(next) : ''), { credentials: 'include', cache: 'no-store' });
    if (!response.ok) {
      setError('Activity could not be loaded');
      setLoading(false);
      return;
    }
    const result = await response.json() as { items: Array<{ id: string; eventType?: string; createdAt: string; actorName?: string; summary?: string }>; nextCursor: string | null };
    setItems((current) => next ? [...current, ...result.items] : result.items);
    setCursor(result.nextCursor);
    setLoading(false);
  }, [ticketId]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="timeline">
      <h3>Activity</h3>
      {loading && !items.length ? <p className="empty-state">Loading activity…</p> : null}
      {error ? <p className="form-error" role="alert">{error} <button type="button" onClick={() => void load()}>Try again</button></p> : null}
      {!loading && !error && !items.length ? <p className="empty-state">No activity yet.</p> : null}
      {items.map((event) => (
        <div className="timeline-item" key={event.id}>
          <i className="active"></i>
          <div>
            <strong>{event.summary || activitySentence(event.eventType ?? '', event.actorName || 'The system')}</strong>
            <span>{eventTime(event.createdAt)}</span>
          </div>
        </div>
      ))}
      {cursor && <button type="button" onClick={() => void load(cursor)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>}
    </div>
  );
}

export function StaffWorkspace({ focusId }: { focusId?: string } = {}) {
  const profile = useProfile();
  const sectionQuery = useSearchParams().get('section');
  const { items, loading, error: loadError, refresh, connection } = useApiTickets('view=active');
  const { items: history } = useApiTickets('view=closed&limit=10');
  const [actionError, setActionError] = useState('');
  const [otpValue, setOtpValue] = useState('');
  const [otpError, setOtpError] = useState('');
  const [otpSuccess, setOtpSuccess] = useState('');
  const [availability, setAvailability] = useState<'ON_DUTY' | 'PAUSED' | 'OFF_DUTY' | 'OFFLINE'>('OFF_DUTY');
  const [workload, setWorkload] = useState({ activeCount: 0, completedToday: 0, capacity: 0 });
  const [actionPending, setActionPending] = useState(false);
  const [pendingTicketId, setPendingTicketId] = useState<string | null>(null);
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
  const ordered = [...items].sort((left, right) => left.no.localeCompare(right.no));
  const focused = focusId ? (ordered.find((ticket) => ticket.id === focusId) ?? history.find((ticket) => ticket.id === focusId)) : undefined;

  useEffect(() => {
    setOtpValue('');
    setOtpError('');
    setOtpSuccess('');
  }, [focused?.id, focused?.status]);

  const refreshWorkload = useCallback(async () => {
    const response = await apiFetch('/api/workforce/me', { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json() as typeof workload & { availability: typeof availability };
    setAvailability(result.availability);
    setWorkload(result);
  }, []);
  useEffect(() => { void refreshWorkload(); }, [refreshWorkload]);
  useEffect(() => {
    if (sectionQuery === 'completed') setSection('history');
    if (sectionQuery === 'availability') setSection('availability');
  }, [sectionQuery]);
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

  async function transition(ticket?: Ticket) {
    if (!ticket) return;
    if (!['ASSIGNED', 'SNOOZED', 'ACCEPTED', 'IN_PROGRESS'].includes(ticket.status)) return;
    setActionPending(true);
    setPendingTicketId(ticket.id);
    const next = ticket.status === 'ACCEPTED' ? 'IN_PROGRESS' : ticket.status === 'IN_PROGRESS' ? 'AWAITING_OTP' : 'ACCEPTED';
    const response = await apiFetch('/api/tickets/' + ticket.id + '/transition', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: next }),
    });
    if (!response.ok) {
      setActionError(await apiErrorMessage(response, next === 'AWAITING_OTP' ? 'Could not request completion. Try again.' : 'Action could not be confirmed'));
      setActionPending(false);
      setPendingTicketId(null);
      return;
    }
    setActionError('');
    await refresh();
    await refreshWorkload();
    setActionPending(false);
    setPendingTicketId(null);
  }

  async function snooze(ticket?: Ticket) {
    if (!ticket) return;
    setActionPending(true);
    setPendingTicketId(ticket.id);
    const response = await apiFetch('/api/tickets/' + ticket.id + '/snooze', { method: 'POST', credentials: 'include' });
    if (!response.ok) {
      setActionError(await apiErrorMessage(response, 'Snooze could not be confirmed'));
      setActionPending(false);
      setPendingTicketId(null);
      return;
    }
    setActionError('');
    await refresh();
    setActionPending(false);
    setPendingTicketId(null);
  }

  async function verifyOtp() {
    if (!focused || otpValue.length !== 6 || actionPending) return;
    setActionPending(true);
    setOtpError('');
    const response = await apiFetch('/api/tickets/' + focused.id + '/otp/verify', {
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

  const serviceName = serviceLabel(profile?.scopes.find((scope) => scope.serviceType)?.serviceType ?? '');

  return (
    <OperationalClock timeZone={profile?.scopes[0]?.event.timezone}>
    <div className="mobile-page">
      <main className="mobile-shell staff">
        <header className="mobile-header">
          <div>
            <span className="eyebrow">Your tasks · {connection === 'live' ? 'Live' : 'Reconnecting'}</span>
            <h1>{profile?.name ?? 'Service workspace'}</h1>
            {serviceName ? <p className="staff-role">{serviceName}</p> : null}
          </div>
          <span className={'duty duty-badge ' + availability.toLowerCase()} aria-label={`Availability ${availability.replaceAll('_', ' ')}`}>
            {availability === 'ON_DUTY' ? 'On duty' : availability === 'PAUSED' ? 'Paused' : 'Off duty'}
          </span>
        </header>
        {actionError && <div className="form-error" role="alert">{actionError}</div>}
        {focusId ? (
          <StaffTaskDetail
            ticket={focused}
            loading={loading}
            error={loadError}
            actionPending={actionPending}
            otpValue={otpValue}
            otpError={otpError}
            otpSuccess={otpSuccess}
            backHref={focused && ['CLOSED', 'CANCELLED'].includes(focused.status) ? '/staff?section=completed' : '/staff'}
            onTransition={() => void transition(focused)}
            onSnooze={() => void snooze(focused)}
            onOtpChange={(next) => { setOtpValue(next); setOtpError(''); }}
            onVerify={() => void verifyOtp()}
          />
        ) : (
          <>
            {profile?.id ? <WorkAlertHost userId={profile.id} /> : null}
            {section === 'task' && (
              <section className="staff-board" aria-label="Active tasks">
                <div className="section-title"><div><h2>Active tasks</h2><p>{ordered.length ? `${ordered.length} on your list` : 'Nothing active'}</p></div></div>
                {loading && !ordered.length ? <p className="empty-state">Loading tasks…</p> : loadError ? <p className="form-error" role="alert">{loadError}</p> : ordered.length ? ordered.map((ticket) => (
                  <StaffTaskSummary key={ticket.id} ticket={ticket} pending={actionPending && pendingTicketId === ticket.id} locked={actionPending} onTransition={() => void transition(ticket)} onSnooze={() => void snooze(ticket)} />
                )) : <p className="empty-state">No active tasks. New work appears here when you are on duty and free.</p>}
              </section>
            )}
            {section === 'history' && (
              <section aria-label="Completed tasks">
                <div className="section-title"><h2>Completed tasks</h2></div>
                {history.length ? history.map((ticket) => <StaffTaskSummary key={ticket.id} ticket={ticket} />) : <p className="empty-state">No completed work yet.</p>}
              </section>
            )}
            {section === 'availability' && (
              <section className="availability-panel">
                <div className="section-title"><h2>Availability</h2></div>
                <p>Choose whether you can take new tasks. Tasks already assigned to you stay on your list. {workload.activeCount} active now.</p>
                <button type="button" className={availability === 'ON_DUTY' ? 'primary' : 'secondary-action'} disabled={actionPending} onClick={() => void setAvailabilityValue('ON_DUTY')}>{actionPending ? 'Saving…' : 'On duty · ready for new tasks'}</button>
                <button type="button" className={availability === 'PAUSED' ? 'primary' : 'secondary-action'} disabled={actionPending} onClick={() => void setAvailabilityValue('PAUSED')}>{actionPending ? 'Saving…' : 'Paused · finish current tasks, no new ones'}</button>
                <button type="button" className={availability === 'OFF_DUTY' ? 'primary' : 'secondary-action'} disabled={actionPending} onClick={() => void setAvailabilityValue('OFF_DUTY')}>{actionPending ? 'Saving…' : 'Off duty · not available'}</button>
              </section>
            )}
          </>
        )}
        <nav className="bottom-nav" aria-label="Staff navigation">
          <a className={!focusId && section === 'task' ? 'nav-active' : undefined} href="/staff">Active</a>
          <a className={!focusId && section === 'history' ? 'nav-active' : undefined} href="/staff?section=completed">Completed</a>
          <a className={!focusId && section === 'availability' ? 'nav-active' : undefined} href="/staff?section=availability">Availability</a>
          <LogoutButton />
        </nav>
      </main>
    </div>
    </OperationalClock>
  );
}

function staffStatus(status: string) {
  const labels: Record<string, string> = {
    ASSIGNED: 'New task',
    SNOOZED: 'Snoozed',
    ACCEPTED: 'Accepted',
    IN_PROGRESS: 'In progress',
    AWAITING_OTP: 'Waiting for close code',
    CLOSED: 'Completed',
    CANCELLED: 'Cancelled',
  };
  return labels[status] ?? 'Update';
}

function staffNext(status: string) {
  if (status === 'ACCEPTED') return { label: 'Start work', pending: 'Starting…' };
  if (status === 'IN_PROGRESS') return { label: 'Work done', pending: 'Asking for the close code…' };
  if (status === 'ASSIGNED' || status === 'SNOOZED') return { label: 'Accept task', pending: 'Accepting…' };
  return null;
}

function StaffTaskSummary({ ticket, pending = false, locked = false, onTransition, onSnooze }: {
  ticket: Ticket;
  pending?: boolean;
  locked?: boolean;
  onTransition?: () => void;
  onSnooze?: () => void;
}) {
  const next = staffNext(ticket.status);
  return (
    <article className="task-summary">
      <div className="ticket-top">
        <h2>Stall {ticket.locationParts.stall}</h2>
        <span className={'status status-' + ticket.status.toLowerCase()}>{staffStatus(ticket.status)}</span>
      </div>
      <p>{ticket.locationParts.hall} · Zone {ticket.locationParts.zone}</p>
      <p>{ticket.service}</p>
      <p className="description">{ticket.description}</p>
      <p className="next-action">{next ? `Next: ${next.label}` : staffStatus(ticket.status)}</p>
      <p className="when-line">{ticket.status === 'CLOSED' && ticket.closedAt ? `Completed ${eventTime(ticket.closedAt)}` : `Raised ${eventTime(ticket.createdAt)}`}</p>
      <div className="staff-actions">
        <a href={'/staff/task/' + ticket.id}>Open task</a>
        {next && onTransition ? <button type="button" className="primary" disabled={locked} onClick={onTransition}>{pending ? next.pending : next.label}</button> : null}
        {ticket.status === 'ASSIGNED' && onSnooze ? <button type="button" disabled={locked} onClick={onSnooze}>10 min later</button> : null}
      </div>
    </article>
  );
}

function StaffTaskDetail({ ticket, loading, error, actionPending, otpValue, otpError, otpSuccess, backHref, onTransition, onSnooze, onOtpChange, onVerify }: {
  ticket?: Ticket;
  loading: boolean;
  error: string;
  actionPending: boolean;
  otpValue: string;
  otpError: string;
  otpSuccess: string;
  backHref: string;
  onTransition: () => void;
  onSnooze: () => void;
  onOtpChange: (next: string) => void;
  onVerify: () => void;
}) {
  const next = ticket ? staffNext(ticket.status) : null;
  return (
    <section className="staff-detail" aria-label="Task details">
      <a className="back" href={backHref}>Back to tasks</a>
      {loading && !ticket ? <p className="empty-state">Loading task…</p> : null}
      {!loading && !ticket ? <p className="form-error" role="alert">{error || 'This task is not on your list.'}</p> : null}
      {ticket ? (
        <>
          <div className="ticket-top">
            <h2>Stall {ticket.locationParts.stall}</h2>
            <span className={'status status-' + ticket.status.toLowerCase()}>{staffStatus(ticket.status)}</span>
          </div>
          <p>{ticket.locationParts.hall} · Zone {ticket.locationParts.zone}</p>
          <p>{ticket.service}</p>
          <p className="description">{ticket.description}</p>
          <p className="next-action">{next ? `Next: ${next.label}` : ticket.status === 'AWAITING_OTP' ? 'Next: ask for the completion code' : staffStatus(ticket.status)}</p>
          <p className="when-line">{ticket.status === 'CLOSED' && ticket.closedAt ? `Completed ${eventTime(ticket.closedAt)}` : `Raised ${eventTime(ticket.createdAt)}`}</p>
          {next ? (
            <div className="staff-actions">
              <button type="button" className="primary" disabled={actionPending} onClick={onTransition}>{actionPending ? next.pending : next.label}</button>
              {ticket.status === 'ASSIGNED' ? <button type="button" disabled={actionPending} onClick={onSnooze}>10 min later</button> : null}
            </div>
          ) : null}
          {ticket.status === 'AWAITING_OTP' ? (
            <StaffOtpEntry
              value={otpValue}
              onChange={onOtpChange}
              onSubmit={onVerify}
              submitting={actionPending}
              error={otpError}
              success={otpSuccess}
            />
          ) : null}
          <TicketActivity ticketId={ticket.id} />
        </>
      ) : null}
    </section>
  );
}

const navByRole: Record<'HALL_MANAGER' | 'ADMIN', string[]> = {
  HALL_MANAGER: ['Attention', 'Tickets', 'Queue', 'Staff'],
  ADMIN: ['Command center', 'Tickets', 'Halls / Zones / Stalls', 'Workforce', 'Reports', 'Masters', 'Audit'],
};

function attentionReason(ticket: Ticket): string | null {
  return managerAttentionLabel({
    status: ticket.status,
    slaState: ticket.slaState,
    priority: ticket.priority,
    reopenCount: ticket.reopenCount,
  });
}

function managementStatusIsSuccess(message: string) {
  return message.startsWith('Export queued')
    || message.startsWith('Created ')
    || message.includes('sent for Admin approval')
    || message.startsWith('Staff approved')
    || message.startsWith('Staff request rejected')
    || message.endsWith('created.')
    || message.startsWith('SLA targets')
    || message.includes('Temporary password must be changed')
    || message.startsWith('Completion verified');
}

function managerNextStep(ticket: Ticket): string {
  if (ticket.status === 'AWAITING_OTP' && ticket.capabilities.verifyStallOtp) return 'Enter the completion code';
  if (ticket.status === 'QUEUED') return 'Move it ahead in the queue, with a reason';
  if (['ASSIGNED', 'SNOOZED', 'ACCEPTED'].includes(ticket.status)) return 'Message the worker or reassign';
  if (ticket.status === 'COMPLAINT_RAISED' || ticket.status === 'CLOSED' || ticket.status === 'ESCALATED') return 'Reopen with a reason';
  if (ticket.status === 'IN_PROGRESS') return 'Follow the worker, or escalate with a reason';
  if (ticket.status === 'NEW' || ticket.status === 'REOPENED') return 'It assigns when a free worker is on duty';
  return 'Open the ticket';
}

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
  if (!Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value < 60) return value + 's';
  return Math.floor(value / 60) + 'm ' + String(value % 60).padStart(2, '0') + 's';
}

function percent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '—';
  return Math.round(value * 100) + '%';
}

type OperationalMetrics = {
  open?: number;
  queued?: number;
  overdue?: number;
  escalated?: number;
  complaints?: number;
  closedToday?: number;
  slaBreached?: number;
  oldestOutstandingSeconds?: number | null;
  avgResponseSeconds?: number | null;
  avgResolutionSeconds?: number | null;
  medianResponseSeconds?: number | null;
  p90ResponseSeconds?: number | null;
  medianResolutionSeconds?: number | null;
  p90ResolutionSeconds?: number | null;
  reopenRate?: number | null;
  complaintRate?: number | null;
  staffUtilization?: number | null;
  oldestQueuedSeconds?: number | null;
  oldestAcceptedSeconds?: number | null;
  oldestInProgressSeconds?: number | null;
  categoryBacklog?: Array<{ category: string; open: number }>;
  halls?: Array<{ id: string; code: string; name: string; open: number; queued: number; overdue: number; escalated: number }>;
  workforceLoad?: Array<{ hallCode: string; category: string; onDuty: number; paused: number; offDuty: number; capacity: number; active: number }>;
};

function CommandInsights({ metrics }: { metrics: OperationalMetrics }) {
  const oldest = (value: number | null | undefined) => value == null ? 'None' : duration(value);
  return (
    <>
      <section className="portfolio-list" aria-label="Hall status">
        <div className="section-title"><div><h2>Hall status</h2><p>Open backlog and critical exceptions for each hall in scope</p></div></div>
        {(metrics.halls ?? []).length ? metrics.halls!.map((hall) => (
          <article key={hall.id}>
            <div><strong>{hall.code}</strong><span>{hall.name}</span></div>
            <div><span>Open</span><strong>{hall.open}</strong></div>
            <div><span>Queued</span><strong>{hall.queued}</strong></div>
            <div><span>Overdue</span><strong className={hall.overdue ? 'red' : undefined}>{hall.overdue}</strong></div>
            <div><span>Escalated</span><strong className={hall.escalated ? 'red' : undefined}>{hall.escalated}</strong></div>
          </article>
        )) : <p className="empty-state">No halls are available in this scope.</p>}
      </section>
      <section className="portfolio-list" aria-label="Service and stage timing">
        <div className="section-title"><div><h2>Service backlog and stage timing</h2><p>Open work by category, plus response and resolution distribution</p></div></div>
        <article>
          <div><strong>Reopen rate</strong><span>Tickets reopened at least once</span></div>
          <div><span>Rate</span><strong>{percent(metrics.reopenRate)}</strong></div>
          <div><span>Complaint rate</span><strong>{percent(metrics.complaintRate)}</strong></div>
          <div><span>Staff utilization</span><strong>{percent(metrics.staffUtilization)}</strong></div>
        </article>
        {(metrics.categoryBacklog ?? []).length ? metrics.categoryBacklog!.map((row) => (
          <article key={row.category}>
            <div><strong>{row.category.replaceAll('_', ' ')}</strong><span>Open category backlog</span></div>
            <div><span>Open</span><strong>{row.open}</strong></div>
          </article>
        )) : <p className="empty-state">No open category backlog.</p>}
        <article>
          <div><strong>Response</strong><span>Raise to first acceptance</span></div>
          <div><span>Median</span><strong>{duration(metrics.medianResponseSeconds)}</strong></div>
          <div><span>P90</span><strong>{duration(metrics.p90ResponseSeconds)}</strong></div>
          <div><span>Average</span><strong>{duration(metrics.avgResponseSeconds)}</strong></div>
        </article>
        <article>
          <div><strong>Resolution</strong><span>Raise to final closure</span></div>
          <div><span>Median</span><strong>{duration(metrics.medianResolutionSeconds)}</strong></div>
          <div><span>P90</span><strong>{duration(metrics.p90ResolutionSeconds)}</strong></div>
          <div><span>Average</span><strong>{duration(metrics.avgResolutionSeconds)}</strong></div>
        </article>
        <article>
          <div><strong>Oldest open stages</strong><span>Live age of the oldest ticket still in that stage</span></div>
          <div><span>Unassigned</span><strong>{oldest(metrics.oldestQueuedSeconds)}</strong></div>
          <div><span>Accepted</span><strong>{oldest(metrics.oldestAcceptedSeconds)}</strong></div>
          <div><span>In progress</span><strong>{oldest(metrics.oldestInProgressSeconds)}</strong></div>
        </article>
      </section>
      <section className="portfolio-list" aria-label="Workforce load">
        <div className="section-title"><div><h2>Workforce load</h2><p>Approved staff by hall and service</p></div></div>
        {(metrics.workforceLoad ?? []).length ? metrics.workforceLoad!.map((row) => (
          <article key={row.hallCode + row.category}>
            <div><strong>{row.hallCode}</strong><span>{row.category.replaceAll('_', ' ')}</span></div>
            <div><span>On duty</span><strong>{row.onDuty}</strong></div>
            <div><span>Paused / off</span><strong>{row.paused}/{row.offDuty}</strong></div>
            <div><span>Active load</span><strong>{row.active}/{row.capacity}</strong></div>
          </article>
        )) : <p className="empty-state">No workforce memberships in this scope.</p>}
      </section>
    </>
  );
}

function eventTime(value: string | null | undefined, timezone = 'UTC') {
  if (!value) return 'Pending';
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function TicketDrawer({ ticket, timing, detail, eligibleStaff, onPing, onReassign, onReopen, onEscalate, onOverrideClose, onAdvance, onPrioritize, onSetServicePriority, onCancel, onVerifyOtp, canAdmin, canAdvance, canEmergencyClose, canVerifyOtp, activityOpen = false, onBack, actionError }: {
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
  onSetServicePriority: (servicePriority: 'HIGH' | 'MEDIUM' | 'LOW', reason: string) => Promise<unknown>;
  onCancel: (reason: string) => Promise<unknown>;
  onVerifyOtp?: (otp: string) => Promise<boolean>;
  canAdmin: boolean;
  canAdvance: boolean;
  canEmergencyClose: boolean;
  canVerifyOtp?: boolean;
  activityOpen?: boolean;
  onBack?: () => void;
  actionError?: string;
}) {
  const [pendingAction, setPendingAction] = useState<'ping' | 'reassign' | 'reopen' | 'escalate' | 'override' | 'prioritize' | 'service-priority' | 'cancel' | null>(null);
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
    ['Closed', ticket.status === 'CLOSED' ? (timing?.closedAt ?? detail?.closedAt) : null, ticket.status === 'CLOSED' && timing?.otpWaitSeconds != null ? duration(timing.otpWaitSeconds) + ' verification wait' : (ticket.status === 'AWAITING_OTP' ? 'Pending verification' : null)],
  ];
  const overrideEvent = [...(detail?.events ?? [])].reverse().find((event) => event.eventType === 'QUEUE_PRIORITY_OVERRIDDEN');
  const overrideReason = overrideEvent && overrideEvent.metadata && typeof overrideEvent.metadata === 'object' && 'reason' in overrideEvent.metadata
    ? String((overrideEvent.metadata as { reason?: unknown }).reason ?? '')
    : '';
  return (
    <aside className="drawer" aria-label={'Ticket ' + ticket.no + ' detail'}>
      {onBack ? <button type="button" onClick={onBack}>Back to the list</button> : null}
      <div className="drawer-head"><div><span className="eyebrow">{ticket.no}</span><h2>{ticket.service}</h2></div><Status value={ticket.status} audience="manager" /></div>
      <p className="description">{ticket.description}</p>
      <div className="ticket-meta"><TimingFacts ticket={ticket} /></div>
      <div className="drawer-location location-emphasis"><span>{ticket.locationParts.hall} · {ticket.locationParts.zone}</span><strong>Stall {ticket.locationParts.stall}</strong>{ticket.servicePriority && <span>Stall priority {ticket.servicePriority}</span>}{ticket.priority ? <span>Urgent</span> : null}<span>SLA {ticket.slaState}</span>{ticket.queuePriorityOverrideAt ? <span>Moved ahead in the queue{overrideReason ? `: ${overrideReason}` : ''}</span> : null}</div>
      <div className="cycles"><h3>Assignment</h3><div><strong>{detail?.currentAssignee?.name ?? detail?.lastAssignee?.name ?? ticket.assignee}</strong><span>{detail?.currentAssignee ? 'Current assignee' : (detail?.lastAssignee ? 'Last assignee' : 'Queue / ownership')}</span></div></div>
      <div className="timing"><h3>Service timing</h3><div className="timing-strip"><span><b>{duration(timing?.raiseToAssignSeconds)}</b>Dispatch</span><span><b>{duration(timing?.assignToAcceptSeconds)}</b>Response</span><span><b>{duration(timing?.mobilizationSeconds)}</b>Mobilize</span><span><b>{duration(timing?.activeWorkSeconds)}</b>Work</span><span><b>{duration(timing?.otpWaitSeconds)}</b>OTP wait</span><span><b>{duration(timing?.totalResolutionSeconds)}</b>Total</span></div></div>
      <div className="timeline"><h3>Lifecycle milestones</h3>{milestones.map(([event, time, relative], index) => <div key={event} className="timeline-item"><i className={time ? 'active' : ''}></i><div><strong>{event}</strong><span>{time ? eventTime(time, timing?.eventTimezone) : (event === 'Closed' && ticket.status === 'AWAITING_OTP' ? 'Pending verification' : '—')}</span>{relative && <span>{relative}</span>}</div><time>{index === 0 ? 'Event time' : ''}</time></div>)}</div>
      {!!timing?.workCycles.length && <div className="cycles"><h3>Work cycles</h3>{timing.workCycles.map((cycle) => <div key={cycle.attempt}><strong>Attempt {cycle.attempt}</strong><span>{eventTime(cycle.assignedAt, timing.eventTimezone)} · {cycle.releasedAt ? 'Completed/released' : 'Active'}</span></div>)}</div>}
      {!!detail?.complaints.length && <div className="cycles"><h3>Complaints</h3>{detail.complaints.map((complaint) => <div key={complaint.id}><strong>{complaint.reasonCode.replaceAll('_', ' ')}</strong><span>{complaint.comment || 'No additional note'} · {eventTime(complaint.createdAt, timing?.eventTimezone)}</span></div>)}</div>}
      {activityOpen ? <section aria-label="Activity"><TicketActivity ticketId={ticket.id} /></section> : <details className="complaint-disclosure"><summary>Activity</summary><TicketActivity ticketId={ticket.id} /></details>}
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
        {['ASSIGNED', 'SNOOZED', 'ACCEPTED'].includes(ticket.status) && <><button onClick={() => setPendingAction('ping')}>Message the worker</button><button onClick={() => setPendingAction('reassign')}>Reassign worker</button></>}
        {['CLOSED', 'COMPLAINT_RAISED', 'ESCALATED'].includes(ticket.status) && <button onClick={() => setPendingAction('reopen')}>Reopen with a reason</button>}
        {ticket.status === 'QUEUED' && <button onClick={() => setPendingAction('prioritize')}>Move ahead in the queue</button>}
        {['NEW', 'QUEUED', 'REOPENED'].includes(ticket.status) && <button onClick={() => setPendingAction('service-priority')}>Change stall priority</button>}
        {['SNOOZED', 'IN_PROGRESS', 'COMPLAINT_RAISED'].includes(ticket.status) && <button className="critical-button" onClick={() => setPendingAction('escalate')}>Escalate with a reason</button>}
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
                    : pendingAction === 'service-priority' ? onSetServicePriority(String(values.get('servicePriority') ?? 'MEDIUM') as 'HIGH' | 'MEDIUM' | 'LOW', reason)
                      : onCancel(reason);
        void Promise.resolve(action)
          .then((result) => { if (result !== false) setPendingAction(null); })
          .catch(() => undefined)
          .finally(() => setSubmitting(false));
      }}>
        {pendingAction === 'reassign' && <label>Eligible worker<select name="staffId" required disabled={submitting}><option value="">Choose worker</option>{eligibleStaff.map((membership) => <option key={membership.user.id} value={membership.user.id}>{membership.user.name}{membership.user.employeeCode ? ` · ${membership.user.employeeCode}` : ''} · {membership.pool.category} {membership.pool.subtype}</option>)}</select></label>}
        {pendingAction === 'service-priority' && <label>Service priority<select name="servicePriority" required defaultValue={ticket.servicePriority ?? 'MEDIUM'} disabled={submitting}><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></select></label>}
        <label>{pendingAction === 'ping' ? 'Message' : 'Required reason'}<textarea name="reason" required minLength={3} maxLength={500} disabled={submitting} /></label>
        {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
        <div><button type="button" disabled={submitting} onClick={() => setPendingAction(null)}>Back</button><button className={['override', 'cancel'].includes(pendingAction) ? 'critical-button' : 'primary'} type="submit" disabled={submitting}>{submitting ? 'Saving…' : 'Confirm'}</button></div>
      </form>}
    </aside>
  );
}

export function ManagementWorkspace({ role }: { role: 'HALL_MANAGER' | 'ADMIN' }) {
  const profile = useProfile();
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [hallFilter, setHallFilter] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
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
    ...(hallFilter ? { hallId: hallFilter } : {}),
    ...(createdFrom ? { createdFrom: new Date(createdFrom).toISOString() } : {}),
    ...(createdTo ? { createdTo: new Date(createdTo).toISOString() } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  }).toString();
  const { items, total, nextCursor, loading, error: loadError, refresh, loadMore, connection, lastUpdatedAt } = useApiTickets(ticketQuery);
  const queueQuery = new URLSearchParams({
    view: 'queued',
    limit: role === 'HALL_MANAGER' ? '50' : '1',
    ...(role === 'HALL_MANAGER' && categoryFilter ? { category: categoryFilter } : {}),
    ...(role === 'HALL_MANAGER' && hallFilter ? { hallId: hallFilter } : {}),
    ...(role === 'HALL_MANAGER' && debouncedSearch ? { search: debouncedSearch } : {}),
  }).toString();
  const attentionQuery = role === 'HALL_MANAGER' ? 'view=attention&limit=50' : 'view=active&limit=1';
  const { items: queuedItems, total: queueTotal, nextCursor: queueCursor, loading: queueLoading, error: queueError, refresh: refreshQueue, loadMore: loadMoreQueue } = useApiTickets(queueQuery);
  const { items: attentionSource, total: attentionTotal, nextCursor: attentionCursor, loading: attentionLoading, error: attentionError, refresh: refreshAttention, loadMore: loadMoreAttention } = useApiTickets(attentionQuery);
  const [timings, setTimings] = useState<Record<string, TimingRecord>>({});
  const [liveMetrics, setLiveMetrics] = useState<OperationalMetrics>({});
  const [detail, setDetail] = useState<TicketDetail>();
  const [managementError, setManagementError] = useState('');
  const [notifications, setNotifications] = useState<Array<{ id: string; type: string; readAt: string | null; sentAt: string; ticketId?: string | null; payload?: { summary?: string } | null }>>([]);
  const [managerToast, setManagerToast] = useState<{ text: string; ticketId?: string | null } | null>(null);
  const seenManagerAlerts = useRef(new Set<string>());
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
  const [reportRange, setReportRange] = useState<'live' | 'today' | 'custom'>('live');
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
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
  const showLive = role === 'HALL_MANAGER' ? activeSection === 'Tickets' : ['Command center', 'Tickets'].includes(activeSection);
  const showCommand = activeSection === 'Command center' || activeSection === 'Hall overview';
  const hallOptions = liveMetrics.halls ?? [];
  const filtersActive = Boolean(statusFilter || categoryFilter || hallFilter || createdFrom || createdTo || search);
  const metrics = [
    { label: 'Open now', value: String(liveMetrics.open ?? '—') },
    { label: 'Queued', value: String(liveMetrics.queued ?? '—') },
    { label: 'Response overdue', value: String(liveMetrics.overdue ?? '—'), critical: true },
    { label: 'Escalated & complaints', value: liveMetrics.open == null && liveMetrics.queued == null ? '—' : String((liveMetrics.escalated ?? 0) + (liveMetrics.complaints ?? 0)), critical: true },
    { label: 'Closed today', value: String(liveMetrics.closedToday ?? '—') },
    { label: 'SLA breached', value: String(liveMetrics.slaBreached ?? '—'), critical: true },
    { label: 'Avg. response', value: duration(liveMetrics.avgResponseSeconds) },
  ];

  const attentionItems = role === 'HALL_MANAGER' ? attentionSource : [];

  useEffect(() => {
    if (role === 'HALL_MANAGER') {
      setSelected((current) => {
        if (!current) return null;
        return items.find((ticket) => ticket.id === current.id)
          ?? attentionSource.find((ticket) => ticket.id === current.id)
          ?? queuedItems.find((ticket) => ticket.id === current.id)
          ?? current;
      });
      return;
    }
    setSelected((current) => current ? items.find((ticket) => ticket.id === current.id) ?? null : items[0] ?? null);
  }, [items, attentionSource, queuedItems, role]);

  const loadManagement = useCallback(async () => {
    try {
      const metricsParameters = new URLSearchParams();
      if (reportRange === 'today') metricsParameters.set('range', 'today');
      if (reportRange === 'custom') {
        if (reportFrom) metricsParameters.set('from', new Date(reportFrom).toISOString());
        if (reportTo) metricsParameters.set('to', new Date(reportTo).toISOString());
      }
      const metricsQuery = metricsParameters.size ? '?' + metricsParameters.toString() : '';
      const [metricResponse, timingResponse] = await Promise.all([
      apiFetch('/api/management/metrics' + metricsQuery, { credentials: 'include', cache: 'no-store' }),
      apiFetch('/api/management/timing', { credentials: 'include', cache: 'no-store' }),
      ]);
      const errors: string[] = [];
      if (metricResponse.ok) {
        setLiveMetrics(await metricResponse.json() as OperationalMetrics);
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
  }, [reportRange, reportFrom, reportTo]);
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

  useEffect(() => {
    void apiFetch('/api/notifications', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const rows = await response.json() as typeof notifications;
        setNotifications(rows);
        const fresh = rows.find((row) => !row.readAt && ['TICKET_CREATED', 'TICKET_REOPENED'].includes(row.type) && !seenManagerAlerts.current.has(row.id) && Date.now() - new Date(row.sentAt).getTime() < 120000);
        if (!fresh) return;
        for (const row of rows) seenManagerAlerts.current.add(row.id);
        setManagerToast({ text: fresh.payload?.summary ?? (fresh.type === 'TICKET_REOPENED' ? 'Ticket opened again' : 'New request'), ticketId: fresh.ticketId });
      })
      .catch(() => undefined);
  }, [lastUpdatedAt]);
  async function openManagerAlert(alert: { ticketId?: string | null }) {
    setManagerToast(null);
    setActiveSection('Tickets');
    if (!alert.ticketId) return;
    const existing = items.find((ticket) => ticket.id === alert.ticketId);
    if (existing) { setSelected(existing); return; }
    const response = await apiFetch('/api/tickets/' + alert.ticketId, { credentials: 'include', cache: 'no-store' });
    if (response.ok) setSelected(mapTicket(await response.json() as ApiTicket));
  }
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
    await Promise.all([refresh(), refreshQueue(), refreshAttention()]);
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
    await Promise.all([refresh(), refreshQueue(), refreshAttention()]);
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
      body.servicePriority = String(values.get('servicePriority') ?? 'MEDIUM');
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

  const eligibleStaff = workforce.filter((membership) => membership.availability === 'ON_DUTY' && (membership.user.approvalStatus ?? 'APPROVED') === 'APPROVED' && membership.user.status !== 'DISABLED');
  const ticketPanel = selected ? (
    <TicketDrawer
      ticket={selected}
      timing={timings[selected.id]}
      detail={detail}
      canAdmin={role === 'ADMIN'}
      canEmergencyClose={selected.capabilities.emergencyClose}
      canAdvance={selected.capabilities.advanceHallManagerWork}
      canVerifyOtp={!!selected.capabilities.verifyStallOtp}
      eligibleStaff={eligibleStaff}
      activityOpen={role === 'HALL_MANAGER'}
      onBack={role === 'HALL_MANAGER' ? () => setSelected(null) : undefined}
      actionError={managementError && !managementStatusIsSuccess(managementError) ? managementError : ''}
      onAdvance={() => void runTicketAction('/transition', { to: selected.status === 'ACCEPTED' ? 'IN_PROGRESS' : selected.status === 'IN_PROGRESS' ? 'AWAITING_OTP' : 'ACCEPTED' })}
      onPing={(message) => runTicketAction('/ping', { message })}
      onReassign={reassignSelected}
      onReopen={(reason) => transitionSelected('REOPENED', reason)}
      onEscalate={(reason) => transitionSelected('ESCALATED', reason)}
      onPrioritize={(reason) => runTicketAction('/prioritize', { reason })}
      onSetServicePriority={(servicePriority, reason) => runTicketAction('/service-priority', { servicePriority, reason })}
      onCancel={(reason) => transitionSelected('CANCELLED', reason)}
      onOverrideClose={(reason) => runTicketAction('/override-close', { reason })}
      onVerifyOtp={async (otp) => {
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
        await Promise.all([refresh(), refreshQueue(), refreshAttention()]);
        return true;
      }}
    />
  ) : null;

  return (
    <OperationalClock timeZone={profile?.scopes[0]?.event.timezone}>
    <div className="app-shell">
      <aside className={role === 'HALL_MANAGER' ? 'sidebar hall-manager' : 'sidebar'}>
        <div className="brand"><span>E</span>EveOps</div>
        <nav aria-label={role === 'ADMIN' ? 'Admin navigation' : 'Hall Manager navigation'}>
          {navByRole[role].map((item) => <button className={activeSection === item ? 'active' : ''} aria-current={activeSection === item ? 'page' : undefined} onClick={() => { setActiveSection(item); if (role === 'HALL_MANAGER') { setSelected(null); window.scrollTo({ top: 0 }); } }} key={item}>{item}{item === 'Attention' && attentionTotal > 0 ? <i>{attentionTotal}</i> : null}{item === 'Workforce' && role === 'ADMIN' && pendingApprovals.length > 0 && <i>{pendingApprovals.length}</i>}</button>)}
          {role === 'ADMIN' && <Link href="/admin/registrations">Registrations</Link>}
        </nav>
        <div className="user"><span>{role === 'ADMIN' ? 'AD' : 'HM'}</span><div><strong>{profile?.name ?? (role === 'ADMIN' ? 'Event Admin' : 'Hall Manager')}</strong><small>{role.replace('_', ' ')}</small></div></div>
        <LogoutButton />
      </aside>
      <main className="management">
        <header className="topbar"><div><span className="eyebrow">{profile?.scopes[0]?.event.name ?? 'EveOps event'} · {connection === 'live' ? 'Live' : 'Reconnecting'}</span><h1>{title}</h1></div><div className="top-actions"><span>{profile?.scopes[0]?.hall?.name ?? 'All scoped halls'}</span><button onClick={() => void loadNotifications()}>Notifications · {notifications.filter((notification) => !notification.readAt).length}</button></div></header>
        {role === 'HALL_MANAGER' && profile?.id ? <WorkAlertHost userId={profile.id} /> : null}
        {managerToast && <div className="alert-line" role="status"><span>{managerToast.text}</span><button type="button" onClick={() => void openManagerAlert(managerToast)}>Open</button><button type="button" onClick={() => setManagerToast(null)}>Dismiss</button></div>}
        {managementError && <div className={managementStatusIsSuccess(managementError) ? 'alert-line' : 'form-error'} role="status">{managementError}</div>}
        {showNotifications && <section className="notification-panel">{notifications.length ? notifications.slice(0, 10).map((notification) => <button key={notification.id} onClick={() => void apiFetch('/api/notifications/' + notification.id + '/read', { method: 'PATCH', credentials: 'include' }).then(() => loadNotifications())}><strong>{notification.type.replaceAll('_', ' ')}</strong><span>{eventTime(notification.sentAt)}</span></button>) : <p className="empty-state">No notifications.</p>}</section>}
        {role !== 'HALL_MANAGER' && <section className="metric-grid" aria-label="Operational metrics">{metrics.map((metric) => <article key={metric.label} className={metric.critical ? 'metric critical' : 'metric'}><span>{metric.label}</span><strong>{metric.value}</strong><small>Updated live</small></article>)}</section>}
        {showCommand && <CommandInsights metrics={liveMetrics} />}
        {(activeSection === 'Staff' || activeSection === 'Workforce') && (() => {
          const visibleWorkforce = workforce.filter((membership) => workforceFilter === 'ALL' || membership.user.approvalStatus === workforceFilter);
          return <section className="portfolio-list"><div className="section-title"><div><h2>Workforce</h2><p>{role === 'HALL_MANAGER' ? 'Request Electrical or House Help staff. An Admin approves them before they can sign in. Stall registration and exhibitor logins stay with Admin.' : 'Approve Hall Manager staff requests and manage event workforce identities.'}</p></div><div className="drawer-actions"><select aria-label="Approval filter" value={workforceFilter} onChange={(event) => setWorkforceFilter(event.target.value as typeof workforceFilter)}><option value="ALL">All</option><option value="PENDING_APPROVAL">Pending approval</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select><button onClick={() => { const next = !showAddPerson; setShowAddPerson(next); setPersonFormError(''); if (next) { setPersonRole('STAFF'); setPersonServiceCategory('HOUSE_HELP'); const halls = role === 'ADMIN' ? masters.flatMap((event) => event.halls).filter((hall) => hall.active !== false) : (profile?.scopes.flatMap((scope) => scope.hall ? [{ id: scope.hall.id, code: scope.hall.code, name: scope.hall.name }] : []) ?? []); setPersonHallId(halls[0]?.id ?? ''); if (role === 'ADMIN' && !masters.length) void apiFetch('/api/management/masters', { credentials: 'include', cache: 'no-store' }).then(async (response) => { if (response.ok) setMasters(await response.json() as typeof masters); }); } }}>{showAddPerson ? 'Close form' : (role === 'HALL_MANAGER' ? 'Add Staff' : 'Add person')}</button></div></div>{role === 'ADMIN' && !!pendingApprovals.length && <div className="portfolio-list"><div className="section-title"><div><h2>Pending approvals</h2><p>{pendingApprovals.length} awaiting review</p></div></div>{pendingApprovals.map((person) => <article key={person.id}><div><strong>{person.name}</strong><span>{person.employeeCode ?? 'No public ID'} · {person.memberships[0]?.pool.category ?? 'Staff'}</span></div><div><span>Requested by</span><strong>{person.requestedBy?.name ?? 'Hall Manager'}</strong></div><div><span>Created</span><strong>{eventTime(person.createdAt)}</strong></div><div className="drawer-actions"><button className="primary" type="button" onClick={() => void approvePerson(person.id)}>Approve</button><button className="critical-button" type="button" onClick={() => void rejectPerson(person.id)}>{rejectUserId === person.id ? 'Confirm reject' : 'Reject'}</button></div>{rejectUserId === person.id && <form className="authority-action" onSubmit={(event) => { event.preventDefault(); void rejectPerson(person.id); }}><label>Rejection reason<span aria-hidden="true"> *</span><input value={rejectReason} onChange={(change) => setRejectReason(change.target.value)} required minLength={3} /></label>{rejectError && <p className="form-error" role="alert">{rejectError}</p>}<div className="drawer-actions"><button type="button" onClick={() => { setRejectUserId(null); setRejectError(''); }}>Cancel</button><button className="critical-button" type="submit">Submit rejection</button></div></form>}</article>)}</div>}{showAddPerson && (() => {
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
          })()}{visibleWorkforce.length ? visibleWorkforce.map((membership) => <article key={membership.user.id + membership.pool.category + membership.pool.subtype}><div><strong>{membership.user.name}</strong><span>{membership.user.employeeCode ?? 'No public ID'}{membership.user.email ? (' · ' + membership.user.email) : ''}</span></div><div><span>Service</span><strong>{serviceLabel(membership.pool.category)} · {membership.pool.subtype}</strong></div><div><span>Availability</span><strong>{membership.availability.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())}</strong></div><div><span>Load</span><strong>{membership.activeAssignmentCount ?? membership.activeCount ?? 0}/{membership.capacity ?? 1}</strong></div><div><span>Approval</span><strong>{(membership.user.approvalStatus ?? 'APPROVED').replaceAll('_', ' ')}</strong></div><div><span>Account</span><strong>{membership.user.status ?? 'ACTIVE'}</strong></div>{membership.user.rejectionReason && <div><span>Rejection</span><strong>{membership.user.rejectionReason}</strong></div>}{role === 'ADMIN' && membership.user.approvalStatus === 'PENDING_APPROVAL' && <div className="drawer-actions"><button className="primary" type="button" onClick={() => void approvePerson(membership.user.id)}>Approve</button><button className="critical-button" type="button" onClick={() => void rejectPerson(membership.user.id)}>{rejectUserId === membership.user.id ? 'Confirm reject' : 'Reject'}</button></div>}{rejectUserId === membership.user.id && <form className="authority-action" onSubmit={(event) => { event.preventDefault(); void rejectPerson(membership.user.id); }}><label>Rejection reason<span aria-hidden="true"> *</span><input value={rejectReason} onChange={(change) => setRejectReason(change.target.value)} required minLength={3} /></label>{rejectError && <p className="form-error" role="alert">{rejectError}</p>}<div className="drawer-actions"><button type="button" onClick={() => { setRejectUserId(null); setRejectError(''); }}>Cancel</button><button className="critical-button" type="submit">Submit rejection</button></div></form>}<div className="drawer-actions">{capacityEditUserId === membership.user.id ? <form className="authority-action" onSubmit={(event) => { event.preventDefault(); const nextCapacity = Number(capacityValue); if (Number.isInteger(nextCapacity) && nextCapacity >= 1) void updatePersonCapacity(membership.user.id, nextCapacity); }}><label>Capacity<span aria-hidden="true"> *</span><input type="number" min={1} max={20} value={capacityValue} onChange={(change) => setCapacityValue(change.target.value)} required /></label><div className="drawer-actions"><button type="button" onClick={() => setCapacityEditUserId(null)}>Cancel</button><button className="primary" type="submit">Save capacity</button></div></form> : <button type="button" onClick={() => { setCapacityEditUserId(membership.user.id); setCapacityValue(String(membership.capacity ?? 1)); }}>Edit capacity</button>}<button type="button" onClick={() => void updatePersonStatus(membership.user.id, membership.user.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED')}>{membership.user.status === 'DISABLED' ? 'Activate' : 'Deactivate'}</button></div></article>) : <p className="empty-state">No workforce identities match this filter.</p>}</section>;
        })()}
        {activeSection === 'Exceptions' && <section className="portfolio-list"><div className="section-title"><div><h2>Exception inbox</h2><p>Queued, overdue, complaint, reopened, and escalated tickets</p></div></div>{exceptions.length ? exceptions.map((ticket) => <div key={ticket.id}><TicketCard ticket={ticket} /><div className="drawer-actions"><button type="button" onClick={() => { setSelected(ticket); setActiveSection('Tickets'); }}>Open ticket</button></div></div>) : <p className="empty-state">No unresolved exceptions.</p>}</section>}
        {activeSection === 'Audit' && <section className="portfolio-list"><div className="section-title"><div><h2>Audit history</h2><p>Append-only scoped operational events</p></div></div>{auditEvents.map((event) => <article key={event.id}><div><strong>{event.ticket.publicNo}</strong><span>{event.actor?.name ?? 'System'}</span></div><div><span>Action</span><strong>{event.eventType.replaceAll('_', ' ')}</strong></div><div><span>Server time</span><strong>{eventTime(event.createdAt)}</strong></div></article>)}</section>}
        {(activeSection === 'Masters' || activeSection === 'Halls / Zones / Stalls') && <section className="portfolio-list"><div className="section-title"><div><h2>Event setup</h2><p>Halls, zones, stalls, and service timing</p></div><div className="drawer-actions"><button type="button" onClick={() => { setMasterForm(masterForm === 'hall' ? null : 'hall'); setMasterFormError(''); }}>Add hall</button><button type="button" onClick={() => { setMasterForm(masterForm === 'zone' ? null : 'zone'); setMasterFormError(''); }}>Add zone</button><button type="button" onClick={() => { setMasterForm(masterForm === 'stall' ? null : 'stall'); setMasterFormError(''); }}>Add stall</button></div></div>
          {masterForm === 'hall' && <form className="authority-action" onSubmit={(event) => void createMaster(event)}><label>Hall code<span aria-hidden="true"> *</span><input name="code" required minLength={1} /></label><label>Hall name<span aria-hidden="true"> *</span><input name="name" required minLength={1} /></label><label>Status<select name="status" defaultValue="ACTIVE"><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>{masterFormError && <p className="form-error" role="alert">{masterFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setMasterForm(null)}>Cancel</button><button className="primary" type="submit" disabled={masterSubmitting}>{masterSubmitting ? 'Saving…' : 'Create hall'}</button></div></form>}
          {masterForm === 'zone' && <form className="authority-action" onSubmit={(event) => void createMaster(event)}><label>Hall<span aria-hidden="true"> *</span><select name="hallId" required>{masters.flatMap((event) => event.halls).map((hall) => <option key={hall.id} value={hall.id}>{hall.name}</option>)}</select></label><label>Zone code<span aria-hidden="true"> *</span><input name="code" required minLength={1} /></label>{masterFormError && <p className="form-error" role="alert">{masterFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setMasterForm(null)}>Cancel</button><button className="primary" type="submit" disabled={masterSubmitting}>{masterSubmitting ? 'Saving…' : 'Create zone'}</button></div></form>}
          {masterForm === 'stall' && <form className="authority-action" onSubmit={(event) => void createMaster(event)}><label>Zone<span aria-hidden="true"> *</span><select name="zoneId" required>{masters.flatMap((event) => event.halls.flatMap((hall) => hall.zones.map((zone) => <option key={zone.id} value={zone.id}>{hall.name} · {zone.code}</option>)))}</select></label><label>Stall code<span aria-hidden="true"> *</span><input name="stallCode" required minLength={1} /></label><label>Exhibitor<span aria-hidden="true"> *</span><input name="exhibitorName" required minLength={1} /></label><label>Contact<input name="contact" /></label><label>Service priority<select name="servicePriority" defaultValue="MEDIUM"><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></select></label><label>Active<select name="active" defaultValue="true"><option value="true">Active</option><option value="false">Inactive</option></select></label>{masterFormError && <p className="form-error" role="alert">{masterFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setMasterForm(null)}>Cancel</button><button className="primary" type="submit" disabled={masterSubmitting}>{masterSubmitting ? 'Saving…' : 'Create stall'}</button></div></form>}
          {!masters.length ? <p className="empty-state">No master hierarchy is available for your event scope.</p> : masters.map((event) => <div key={event.id}><article><div><strong>{event.name}</strong><span>{event.timezone ? `Timezone ${event.timezone}` : 'Event masters'}</span></div><div><span>Halls</span><strong>{event.halls.length}</strong></div><div><span>Zones</span><strong>{event.halls.reduce((sum, hall) => sum + hall.zones.length, 0)}</strong></div><div><span>Stalls</span><strong>{event.halls.reduce((sum, hall) => sum + hall.zones.reduce((zoneSum, zone) => zoneSum + zone.stalls.length, 0), 0)}</strong></div></article>{event.halls.map((hall) => <article key={hall.id}><div><strong>{hall.name}</strong><span>{hall.zones.length} zones · {hall.zones.reduce((sum, zone) => sum + zone.stalls.length, 0)} stalls</span></div><div><span>Zones</span><strong>{hall.zones.map((zone) => zone.code).join(', ') || 'None'}</strong></div><div><span>Stalls</span><strong>{hall.zones.flatMap((zone) => zone.stalls.map((stall) => stall.stallCode)).join(', ') || 'None'}</strong></div></article>)}{event.pools.map((pool) => <article key={pool.id}><div><strong>{pool.category} · {pool.subtype}</strong><span>{pool.active ? 'Active' : 'Inactive'}</span></div><div><span>Response SLA</span><strong>{duration(pool.responseTargetSeconds)}</strong></div><div><span>Resolution SLA</span><strong>{duration(pool.resolutionTargetSeconds)}</strong></div>{slaEditPoolId === pool.id ? <form className="authority-action" onSubmit={(formEvent) => void updatePool(formEvent, pool)}><label>Response target (seconds)<span aria-hidden="true"> *</span><input name="responseTargetSeconds" type="number" min={1} required defaultValue={pool.responseTargetSeconds} /></label><label>Resolution target (seconds)<span aria-hidden="true"> *</span><input name="resolutionTargetSeconds" type="number" min={1} required defaultValue={pool.resolutionTargetSeconds} /></label>{slaFormError && <p className="form-error" role="alert">{slaFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setSlaEditPoolId(null)}>Cancel</button><button className="primary" type="submit" disabled={slaSubmitting}>{slaSubmitting ? 'Saving…' : 'Save SLA'}</button></div></form> : <button type="button" onClick={() => { setSlaEditPoolId(pool.id); setSlaFormError(''); }}>Edit SLA</button>}</article>)}</div>)}</section>}
        {(activeSection === 'Reports') && <section className="portfolio-list"><div className="section-title"><div><h2>Reports</h2><p>Scoped metrics for the selected creation range, plus authorized CSV export jobs</p></div><div className="drawer-actions"><label className="sr-only" htmlFor="report-range">Report range</label><select id="report-range" aria-label="Report range" value={reportRange} onChange={(event) => setReportRange(event.target.value as 'live' | 'today' | 'custom')}><option value="live">All tickets in scope</option><option value="today">Created today</option><option value="custom">Custom range</option></select>{reportRange === 'custom' && <><label className="sr-only" htmlFor="report-from">From</label><input id="report-from" aria-label="Report from" type="datetime-local" value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} /><label className="sr-only" htmlFor="report-to">To</label><input id="report-to" aria-label="Report to" type="datetime-local" value={reportTo} onChange={(event) => setReportTo(event.target.value)} /></>}<button type="button" onClick={() => void exportView()}>Queue CSV export</button></div></div><CommandInsights metrics={liveMetrics} />{exports.length ? exports.map((job) => <article key={job.id}><div><strong>{job.format}</strong><span>{eventTime(job.createdAt)}</span></div><div><span>Status</span><strong>{job.status}</strong></div><div><span>Rows</span><strong>{job.rowCount ?? 'Pending'}</strong></div>{job.status === 'READY' && <a href={'/api/management/exports/' + job.id + '/download'}>Download</a>}</article>) : <p className="empty-state">No export jobs yet. Queue an export from Live operations or Reports.</p>}</section>}
        {role === 'HALL_MANAGER' && activeSection === 'Attention' && <section className={selected ? 'workspace manager-focus' : 'workspace'} aria-label="Needs attention">
          <div className="operations">
            <div className="section-title"><div><h2>Needs attention</h2><p>{attentionTotal} in this hall. Newly raised, reopened, complained, escalated, urgent, overdue, waiting for a completion code, or assigned and not yet started. Ordinary waiting tickets stay in Queue. Showing {attentionItems.length}.</p></div></div>
            {attentionLoading && !attentionItems.length ? <p className="empty-state">Loading work that needs attention…</p> : attentionError ? <p className="form-error" role="alert">{attentionError}</p> : attentionTotal === 0 ? <p className="empty-state">Nothing needs attention right now.</p> : <div className="manager-list">{attentionItems.map((ticket) => <button type="button" key={ticket.id} className={selected?.id === ticket.id ? 'manager-card selected' : 'manager-card'} onClick={() => setSelected(ticket)}><strong>{attentionReason(ticket) ?? 'Needs attention'}</strong><span>{ticket.location}</span><span>{ticket.service}</span><span>{ticket.no} · {statusLabels[ticket.status]}</span><span>Next: {managerNextStep(ticket)}</span></button>)}</div>}{attentionCursor && <button type="button" onClick={() => void loadMoreAttention()}>Load more</button>}
          </div>
          {ticketPanel}
        </section>}
        {role === 'HALL_MANAGER' && activeSection === 'Queue' && <section className={selected ? 'workspace manager-focus' : 'workspace'} aria-label="Waiting queue">
          <div className="operations">
            <div className="section-title"><div><h2>Waiting queue</h2><p>{queueTotal} waiting · moved-ahead tickets, then high, medium, and low stall priority, then oldest. Urgency does not change this order. Assigned work stays with the worker. Showing {queuedItems.length}. A scheduling position appears only when one service is selected and the search is empty. With more than one service, this is the shared waiting order, not one dispatch line.</p></div></div>
            <div className="filters"><select aria-label="Queue service" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All services</option><option value="ELECTRICAL">Electrical</option><option value="HOUSE_HELP">House Help</option><option value="HALL_MANAGER">Hall Manager</option></select>{hallOptions.length > 1 && <select aria-label="Queue hall" value={hallFilter} onChange={(event) => setHallFilter(event.target.value)}><option value="">All halls</option>{hallOptions.map((hall) => <option key={hall.id} value={hall.id}>{hall.code} · {hall.name}</option>)}</select>}<label className="sr-only" htmlFor="queue-search">Find a waiting ticket</label><input id="queue-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Ticket number or stall" />{(categoryFilter || hallFilter || search) && <button type="button" onClick={() => { setCategoryFilter(''); setHallFilter(''); setSearch(''); }}>Clear filters</button>}</div>
            {queueLoading ? <p className="empty-state">Loading the waiting queue…</p> : queueError ? <p className="form-error" role="alert">{queueError}</p> : !queuedItems.length ? <p className="empty-state">{categoryFilter || hallFilter || search ? 'No waiting tickets match this search.' : 'No tickets are waiting in the queue.'}</p> : <><div className="manager-list">{queuedItems.map((ticket, index) => <button type="button" key={ticket.id} className={selected?.id === ticket.id ? 'manager-card selected' : 'manager-card'} onClick={() => setSelected(ticket)}><span className="eyebrow">{categoryFilter && !search.trim() ? `Scheduling position ${index + 1}` : 'Waiting'}</span><strong>{ticket.no} · Stall {ticket.locationParts.stall}</strong><span>{ticket.location}</span><span>{ticket.service} · {statusLabels[ticket.status]}</span><span>{ticket.queuePriorityOverrideAt ? 'Moved ahead' : `${ticket.servicePriority ?? 'MEDIUM'} stall priority`}{ticket.priority ? ' · Urgent' : ''}</span></button>)}</div>{queueCursor && <button type="button" onClick={() => void loadMoreQueue()}>Load more</button>}</>}
          </div>
          {ticketPanel}
        </section>}
        {showLive && <section className={role === 'HALL_MANAGER' && selected ? 'workspace manager-focus' : 'workspace'}>
          <div className="operations">
            <div className="section-title"><div><h2>{role === 'HALL_MANAGER' ? 'Tickets' : 'Live operations'}</h2><p>{role === 'HALL_MANAGER' ? `${total} tickets in this hall. Open one for the full activity log.` : `${total} scoped tickets · server-authoritative status`}</p></div>{role === 'ADMIN' && <button onClick={() => void exportView()}>Export view</button>}</div>
            <div className="filters"><select aria-label="Status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option>{Object.keys(statusLabels).map((status) => <option key={status} value={status}>{statusLabels[status as TicketStatus]}</option>)}</select><select aria-label="Service filter" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All services</option><option value="ELECTRICAL">Electrical</option><option value="HOUSE_HELP">House Help</option><option value="HALL_MANAGER">Hall Manager</option></select>{hallOptions.length > 1 && <select aria-label="Hall filter" value={hallFilter} onChange={(event) => setHallFilter(event.target.value)}><option value="">All halls</option>{hallOptions.map((hall) => <option key={hall.id} value={hall.id}>{hall.code} · {hall.name}</option>)}</select>}<label className="sr-only" htmlFor="created-from">Created from</label><input id="created-from" aria-label="Created from" type="datetime-local" value={createdFrom} onChange={(event) => setCreatedFrom(event.target.value)} /><label className="sr-only" htmlFor="created-to">Created to</label><input id="created-to" aria-label="Created to" type="datetime-local" value={createdTo} onChange={(event) => setCreatedTo(event.target.value)} /><label className="sr-only" htmlFor="ticket-search">Search tickets</label><input id="ticket-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search ticket or stall" autoFocus={activeSection === 'Search'} />{filtersActive && <button type="button" onClick={() => { setStatusFilter(''); setCategoryFilter(''); setHallFilter(''); setCreatedFrom(''); setCreatedTo(''); setSearch(''); }}>Clear filters</button>}</div>
            {loading ? <p className="empty-state">Loading live operations…</p> : loadError ? <p className="form-error">{loadError}</p> : !items.length ? <p className="empty-state">{filtersActive ? 'No tickets match these filters.' : 'No tickets match the current scope.'}</p> : role === 'HALL_MANAGER' ? <><div className="manager-list">{items.map((ticket) => <button type="button" key={ticket.id} className={selected?.id === ticket.id ? 'manager-card selected' : 'manager-card'} onClick={() => setSelected(ticket)}><strong>{ticket.no} · Stall {ticket.locationParts.stall}</strong><span>{ticket.location}</span><span>{ticket.service}</span><span>{statusLabels[ticket.status]} · {ticket.assignee}</span><TimingFacts ticket={ticket} /></button>)}</div>{nextCursor && <button type="button" onClick={() => void loadMore()}>Load more</button>}</> : <><div className="table-wrap"><table><thead><tr><th>Ticket</th><th>Location / issue</th><th>Status</th><th>Timing</th><th>Response</th><th>Total</th><th>Assignee</th><th>SLA</th></tr></thead><tbody>{items.map((ticket) => <tr key={ticket.no} tabIndex={0} className={selected?.no === ticket.no ? 'selected' : ''} onClick={() => setSelected(ticket)} onKeyDown={(event) => { if (event.key === 'Enter') setSelected(ticket); }}><td><strong>{ticket.no}</strong><small>{ticket.service}</small></td><td><strong>{ticket.location}</strong><small>{ticket.description}</small></td><td><Status value={ticket.status} /></td><td className={ticket.priority ? 'red' : ''}><TimingFacts ticket={ticket} /></td><td>{duration(timings[ticket.id]?.assignToAcceptSeconds)}</td><td>{duration(timings[ticket.id]?.totalResolutionSeconds)}</td><td>{ticket.assignee}</td><td><span className={ticket.slaState === 'On track' ? 'sla' : 'sla breach'}>{ticket.slaState}</span></td></tr>)}</tbody></table></div>{nextCursor && <button type="button" onClick={() => void loadMore()}>Load more</button>}</>}
          </div>
          {ticketPanel}
        </section>}
      </main>
    </div>
    </OperationalClock>
  );
}

type PortfolioEvent = { id: string; event: string; venue: string; status?: string; open: number; exceptions: number; avgResponseSeconds: number | null; medianResponseSeconds: number | null; portfolioMedianResponseSeconds: number | null };

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
  const [explorerStatus, setExplorerStatus] = useState('');
  const [explorerCategory, setExplorerCategory] = useState('');
  const [analytics, setAnalytics] = useState<OperationalMetrics>({});
  const [analyticsError, setAnalyticsError] = useState('');
  const [auditTicket, setAuditTicket] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [governanceMasters, setGovernanceMasters] = useState<Array<{ id: string; name: string; pools: Array<{ id: string; category: string; subtype: string; responseTargetSeconds: number; resolutionTargetSeconds: number; active: boolean }> }>>([]);
  const [slaPoolId, setSlaPoolId] = useState<string | null>(null);
  const [slaError, setSlaError] = useState('');
  useAuthLoss(() => {
    setPortfolio([]);
    setAdmins([]);
    setGovernanceAudit([]);
    setGovernanceExports([]);
    setAnalytics({});
    setGovernanceMasters([]);
    setSelectedEvent('');
  });
  const explorerQuery = new URLSearchParams({
    view: 'all',
    limit: '50',
    ...(selectedEvent ? { eventId: selectedEvent } : {}),
    ...(explorerStatus ? { status: explorerStatus } : {}),
    ...(explorerCategory ? { category: explorerCategory } : {}),
  }).toString();
  const { items: eventTickets, total: eventTicketTotal, loading: ticketsLoading } = useApiTickets(explorerQuery);
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
  useEffect(() => {
    if (!['Audit'].includes(activeSection)) return;
    const parameters = new URLSearchParams();
    if (auditTicket.trim()) parameters.set('ticket', auditTicket.trim());
    if (auditAction.trim()) parameters.set('action', auditAction.trim());
    const timer = setTimeout(() => {
      void apiFetch('/api/management/audit?' + parameters.toString(), { credentials: 'include', cache: 'no-store' })
        .then(async (response) => {
          if (response.ok) setGovernanceAudit(await response.json() as typeof governanceAudit);
        })
        .catch(() => setError('Audit history could not be loaded'));
    }, 300);
    return () => clearTimeout(timer);
  }, [activeSection, auditTicket, auditAction]);
  useEffect(() => {
    if (activeSection !== 'Analytics') return;
    const parameters = new URLSearchParams();
    if (selectedEvent) parameters.set('eventId', selectedEvent);
    void apiFetch('/api/management/metrics?' + parameters.toString(), { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Analytics could not be loaded');
        setAnalytics(await response.json() as OperationalMetrics);
        setAnalyticsError('');
      })
      .catch(() => setAnalyticsError('Analytics could not be loaded'));
  }, [activeSection, selectedEvent]);
  useEffect(() => {
    if (activeSection !== 'Configuration') return;
    void apiFetch('/api/management/masters', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (response.ok) setGovernanceMasters(await response.json() as typeof governanceMasters);
      })
      .catch(() => setError('Configuration could not be loaded'));
  }, [activeSection]);
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
  async function savePoolSla(event: FormEvent<HTMLFormElement>, poolId: string) {
    event.preventDefault();
    setSlaError('');
    const values = new FormData(event.currentTarget);
    const response = await apiFetch('/api/management/masters/pools/' + poolId, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        responseTargetSeconds: Number(values.get('responseTargetSeconds')),
        resolutionTargetSeconds: Number(values.get('resolutionTargetSeconds')),
      }),
    });
    if (!response.ok) {
      setSlaError(await apiErrorMessage(response, 'SLA targets could not be saved'));
      return;
    }
    setSlaPoolId(null);
    const mastersResponse = await apiFetch('/api/management/masters', { credentials: 'include', cache: 'no-store' });
    if (mastersResponse.ok) setGovernanceMasters(await mastersResponse.json() as typeof governanceMasters);
  }
  const visibleEvents = selectedEvent ? portfolio.filter((event) => event.id === selectedEvent) : portfolio;
  return (
    <OperationalClock timeZone={profile?.scopes[0]?.event.timezone}>
    <div className="app-shell super-shell">
      <aside className="sidebar">
        <div className="brand"><span>E</span>EveOps</div>
        <nav aria-label="SuperAdmin navigation">{['Portfolio overview', 'Events', 'Tickets', 'Analytics', 'Exports', 'Configuration', 'Admins', 'Audit'].map((item) => <button className={activeSection === item ? 'active' : ''} onClick={() => setActiveSection(item)} key={item}>{item}</button>)}</nav>
        <div className="user"><span>SA</span><div><strong>{profile?.name ?? 'Organization owner'}</strong><small>SUPER ADMIN</small></div></div>
        <LogoutButton />
      </aside>
      <main className="management">
        <header className="topbar"><div><span className="eyebrow">Organization governance</span><h1>{activeSection}</h1></div><div className="top-actions"><select aria-label="Event" value={selectedEvent} onChange={(event) => setSelectedEvent(event.target.value)}><option value="">All authorized events</option>{portfolio.map((event) => <option key={event.id} value={event.id}>{event.event}</option>)}</select><button type="button" onClick={() => setActiveSection('Analytics')}>Exceptions · {totalExceptions}</button></div></header>
        {error && <div className={error.endsWith('queued.') || error.includes('must be changed') ? 'alert-line' : 'form-error'}>{error}</div>}
        {activeSection === 'Portfolio overview' && <section className="portfolio-hero"><div><span>Authorized events</span><strong>{portfolio.length}</strong></div><div><span>Open tickets</span><strong>{totalOpen}</strong></div><div><span>Cross-event exceptions</span><strong className="red">{totalExceptions}</strong></div><div><span>Median response</span><strong>{medianResponse}</strong></div></section>}
        {(activeSection === 'Portfolio overview' || activeSection === 'Events') && <section className="portfolio-list"><div className="section-title"><div><h2>Event performance</h2><p>Cross-event operational comparison</p></div><button onClick={() => void exportPortfolio()}>Export portfolio</button></div>{loading ? <p className="empty-state">Loading authorized events…</p> : visibleEvents.length ? visibleEvents.map((event) => <article key={event.id}><div><strong>{event.event}</strong><span>{event.venue}{event.status ? ` · ${event.status}` : ''}</span></div><div><span>Open</span><strong>{event.open}</strong></div><div><span>Exceptions</span><strong className="red">{event.exceptions}</strong></div><div><span>Median response</span><strong>{duration(event.medianResponseSeconds)}</strong></div><button onClick={() => { setSelectedEvent(event.id); setActiveSection('Tickets'); }}>Open event</button></article>) : <p className="empty-state">No events are assigned to this governance account.</p>}</section>}
        {activeSection === 'Tickets' && <section className="portfolio-list"><div className="section-title"><div><h2>{selectedEvent ? 'Selected event tickets' : 'Cross-event ticket explorer'}</h2><p>{eventTicketTotal} authorized tickets</p></div><div className="drawer-actions"><select aria-label="Explorer status" value={explorerStatus} onChange={(event) => setExplorerStatus(event.target.value)}><option value="">All statuses</option>{Object.keys(statusLabels).map((status) => <option key={status} value={status}>{statusLabels[status as TicketStatus]}</option>)}</select><select aria-label="Explorer service" value={explorerCategory} onChange={(event) => setExplorerCategory(event.target.value)}><option value="">All services</option><option value="ELECTRICAL">Electrical</option><option value="HOUSE_HELP">House Help</option><option value="HALL_MANAGER">Hall Manager</option></select>{(explorerStatus || explorerCategory) && <button type="button" onClick={() => { setExplorerStatus(''); setExplorerCategory(''); }}>Clear filters</button>}</div></div>{ticketsLoading ? <p className="empty-state">Loading tickets…</p> : eventTickets.length ? eventTickets.map((ticket) => <article key={ticket.id}><div><strong>{ticket.no}</strong><span>{ticket.location}</span></div><div><span>Status</span><Status value={ticket.status} /></div><div><span>Service</span><strong>{ticket.service}</strong></div><div><TimingFacts ticket={ticket} /></div></article>) : <p className="empty-state">No tickets match this explorer.</p>}</section>}
        {activeSection === 'Analytics' && <>{analyticsError && <p className="form-error">{analyticsError}</p>}<CommandInsights metrics={analytics} /></>}
        {activeSection === 'Admins' && <section className="portfolio-list"><div className="section-title"><div><h2>Organization admins</h2><p>Event-scoped operational administrators</p></div><button type="button" onClick={() => { setShowAddAdmin((value) => !value); setAdminFormError(''); }}>{showAddAdmin ? 'Close form' : 'Add admin'}</button></div>{showAddAdmin && <form className="authority-action" onSubmit={(event) => void createAdmin(event)}><label>Name<span aria-hidden="true"> *</span><input name="name" required minLength={2} /></label><label>Email<span aria-hidden="true"> *</span><input name="email" type="email" required /></label><label>Temporary password<span aria-hidden="true"> *</span><input name="password" type="password" required minLength={12} /></label><label>Authorized event IDs (comma separated)<span aria-hidden="true"> *</span><input name="eventIds" required defaultValue={selectedEvent || portfolio.map((event) => event.id).join(',')} /></label>{adminFormError && <p className="form-error" role="alert">{adminFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setShowAddAdmin(false)}>Cancel</button><button className="primary" type="submit" disabled={adminSubmitting}>{adminSubmitting ? 'Creating…' : 'Create admin'}</button></div></form>}{admins.length ? admins.map((admin) => <article key={admin.id}><div><strong>{admin.name}</strong><span>{admin.email}</span></div><div><span>Status</span><strong>{admin.status}</strong></div><div><span>Events</span><strong>{admin.scopes.map((scope) => scope.event.name).join(', ')}</strong></div></article>) : <p className="empty-state">No organization admins yet.</p>}</section>}
        {activeSection === 'Audit' && <section className="portfolio-list"><div className="section-title"><div><h2>Cross-event audit</h2><p>Immutable ticket lifecycle activity</p></div><div className="drawer-actions"><label className="sr-only" htmlFor="audit-ticket">Ticket</label><input id="audit-ticket" aria-label="Audit ticket" value={auditTicket} onChange={(event) => setAuditTicket(event.target.value)} placeholder="Ticket number" /><label className="sr-only" htmlFor="audit-action">Action</label><input id="audit-action" aria-label="Audit action" value={auditAction} onChange={(event) => setAuditAction(event.target.value)} placeholder="Action" /></div></div>{governanceAudit.length ? governanceAudit.map((event) => <article key={event.id}><div><strong>{event.ticket.publicNo}</strong><span>{event.actor?.name ?? 'System'}</span></div><div><span>Action</span><strong>{event.eventType.replaceAll('_', ' ')}</strong></div><div><span>Time</span><strong>{eventTime(event.createdAt)}</strong></div></article>) : <p className="empty-state">No audit events match this search.</p>}</section>}
        {activeSection === 'Exports' && <section className="portfolio-list"><div className="section-title"><div><h2>Export center</h2><p>Authorized cross-event reports. Generated files expire after 24 hours.</p></div><button type="button" onClick={() => void exportPortfolio()}>Queue CSV export</button></div>{governanceExports.length ? governanceExports.map((job) => <article key={job.id}><div><strong>{job.format}</strong><span>{eventTime(job.createdAt)}</span></div><div><span>Status</span><strong>{job.status}</strong></div><div><span>Rows</span><strong>{job.rowCount ?? 'Pending'}</strong></div>{job.status === 'READY' && <a href={'/api/management/exports/' + job.id + '/download'}>Download</a>}</article>) : <p className="empty-state">No export jobs yet.</p>}</section>}
        {activeSection === 'Configuration' && <section className="portfolio-list"><div className="section-title"><div><h2>Service configuration</h2><p>SLA defaults for authorized events. Export files expire after 24 hours.</p></div></div>{governanceMasters.length ? governanceMasters.map((event) => <div key={event.id}>{event.pools.map((pool) => <article key={pool.id}><div><strong>{event.name}</strong><span>{pool.category} · {pool.subtype} · {pool.active ? 'Active' : 'Inactive'}</span></div><div><span>Response SLA</span><strong>{duration(pool.responseTargetSeconds)}</strong></div><div><span>Resolution SLA</span><strong>{duration(pool.resolutionTargetSeconds)}</strong></div>{slaPoolId === pool.id ? <form className="authority-action" onSubmit={(formEvent) => void savePoolSla(formEvent, pool.id)}><label>Response target (seconds)<span aria-hidden="true"> *</span><input name="responseTargetSeconds" type="number" min={1} required defaultValue={pool.responseTargetSeconds} /></label><label>Resolution target (seconds)<span aria-hidden="true"> *</span><input name="resolutionTargetSeconds" type="number" min={1} required defaultValue={pool.resolutionTargetSeconds} /></label>{slaError && <p className="form-error" role="alert">{slaError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setSlaPoolId(null)}>Cancel</button><button className="primary" type="submit">Save SLA</button></div></form> : <button type="button" onClick={() => { setSlaPoolId(pool.id); setSlaError(''); }}>Edit SLA</button>}</article>)}</div>) : <p className="empty-state">No service pools are configured for authorized events.</p>}</section>}
      </main>
    </div>
    </OperationalClock>
  );
}
