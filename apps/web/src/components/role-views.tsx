'use client';

import { NEW_PASSWORD_MIN_LENGTH, NEW_PASSWORD_PATTERN, PASSWORD_MAX_BYTES, type Role, type TicketStatus } from '@eveops/contracts';
import { FormEvent, KeyboardEvent, ClipboardEvent, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { describeTicketTiming, jitteredRetryMs, managerAttentionLabel, retryAfterMs, schedulingQueueLabel, shouldRefreshForTicketEvent } from '@eveops/ticket-timing';
import { apiFetch, apiErrorMessage, AUTH_LOST_EVENT, subscribeRealtime } from '../lib/api-client';
import { useAuditHistory } from '../lib/audit-history';
import { loadSessionProfile, profileSnapshot, subscribeProfile, type SessionProfile } from '../lib/session-profile';
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

function useApiTickets(query = '', options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const [items, setItems] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenEventIds = useRef(new Set<string>());
  const seenTicketVersions = useRef(new Map<string, number>());
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const loadedQuery = useRef('');
  const depthRef = useRef(1);
  const fetchedAt = useRef(0);
  const cooldownUntil = useRef(0);
  const queryRef = useRef(query);
  if (queryRef.current !== query) {
    queryRef.current = query;
    depthRef.current = 1;
  }
  const refresh = useCallback(async (cursor?: string, append = false) => {
    if (!enabled || Date.now() < cooldownUntil.current) return;
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
        if (response.status === 429) {
          const wait = jitteredRetryMs(retryAfterMs(response.headers.get('retry-after')), Math.random());
          cooldownUntil.current = Date.now() + wait;
          if (sequence !== requestSequence.current) return;
          setStale(true);
          setError('Tickets are busy right now. Showing the last loaded list.');
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            cooldownUntil.current = 0;
            void refresh();
          }, wait);
          return;
        }
        if (response.status === 401) {
          setError('Session expired');
          setStale(false);
          return;
        }
        if (response.status === 403) {
          setError('You no longer have access to these tickets.');
          setStale(false);
          return;
        }
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
      fetchedAt.current = Date.now();
      setLastUpdatedAt(Date.now());
      setError('');
      setStale(false);
      loadedQuery.current = query;
    } catch (cause) {
      if (controller.signal.aborted) return;
      setStale(true);
      setError(cause instanceof Error ? cause.message : 'Live tickets could not be loaded');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [enabled, query]);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled) return;
    const scheduleRefresh = () => {
      if (Date.now() < cooldownUntil.current) return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void refresh(), jitteredRetryMs(300, Math.random()));
    };
    const unsubscribe = subscribeRealtime({
      onConnection: (state) => {
        setConnection(state);
        if (state === 'live' && Date.now() - fetchedAt.current < 1500) return;
        if (state === 'live') scheduleRefresh();
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
      scheduleRefresh();
      },
    });
    const reconcile = () => { if (document.visibilityState === 'visible') scheduleRefresh(); };
    const authLost = () => {
      setItems([]);
      setTotal(0);
      setNextCursor(null);
      setStale(false);
      setError('Session expired');
    };
    document.addEventListener('visibilitychange', reconcile);
    window.addEventListener(AUTH_LOST_EVENT, authLost);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      document.removeEventListener('visibilitychange', reconcile);
      window.removeEventListener(AUTH_LOST_EVENT, authLost);
      unsubscribe();
      requestController.current?.abort();
    };
  }, [enabled, refresh]);
  return { items, total, nextCursor, loading, error, stale, refresh, loadMore: () => nextCursor ? refresh(nextCursor, true) : Promise.resolve(), connection, lastUpdatedAt };
}

type Profile = SessionProfile & { role: Role };

function useProfileState() {
  const [snapshot, setSnapshot] = useState(profileSnapshot);
  useEffect(() => {
    void loadSessionProfile();
    return subscribeProfile(() => setSnapshot({ ...profileSnapshot() }));
  }, []);
  return snapshot;
}

function useProfile() {
  return useProfileState().profile as Profile | null;
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
                {loadError && ordered.length ? <p className="alert-line" role="status">{loadError}</p> : null}
                {loading && !ordered.length ? <p className="empty-state">Loading tasks…</p> : loadError && !ordered.length ? <p className="form-error" role="alert">{loadError}</p> : ordered.length ? ordered.map((ticket) => (
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
  ADMIN: ['Overview', 'Tickets', 'Registrations', 'Workforce', 'Event setup', 'Reports', 'Audit'],
};

function adminSectionName(value: string | null) {
  return ['Tickets', 'Workforce', 'Event setup', 'Reports', 'Audit'].includes(value ?? '') ? value ?? 'Overview' : 'Overview';
}

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
        {metrics.halls == null ? <p className="empty-state">Hall figures have not loaded.</p> : metrics.halls.length ? metrics.halls.map((hall) => (
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
        {metrics.categoryBacklog == null ? <p className="empty-state">Category backlog has not loaded.</p> : metrics.categoryBacklog.length ? metrics.categoryBacklog.map((row) => (
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
        {metrics.workforceLoad == null ? <p className="empty-state">Workforce load has not loaded.</p> : metrics.workforceLoad.length ? metrics.workforceLoad.map((row) => (
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
  const profileState = useProfileState();
  const profile = profileState.profile as Profile | null;
  const searchParams = useSearchParams();
  const router = useRouter();
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [statusFilter, setStatusFilter] = useState(role === 'ADMIN' ? (searchParams.get('status') ?? '') : '');
  const [categoryFilter, setCategoryFilter] = useState(role === 'ADMIN' ? (searchParams.get('category') ?? '') : '');
  const [hallFilter, setHallFilter] = useState(role === 'ADMIN' ? (searchParams.get('hall') ?? '') : '');
  const [listView, setListView] = useState<'all' | 'active'>(role === 'ADMIN' && searchParams.get('view') === 'active' ? 'active' : 'all');
  const [stallFilter, setStallFilter] = useState(role === 'ADMIN' ? (searchParams.get('stall') ?? '') : '');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [search, setSearch] = useState(role === 'ADMIN' ? (searchParams.get('q') ?? '') : '');
  const [debouncedSearch, setDebouncedSearch] = useState(role === 'ADMIN' ? (searchParams.get('q') ?? '') : '');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const adminQuery = searchParams.toString();
  useEffect(() => {
    if (role !== 'ADMIN' || searchParams.get('section') !== 'Tickets') return;
    const current = new URLSearchParams(adminQuery).get('q') ?? '';
    if (current === debouncedSearch) return;
    const params = new URLSearchParams(adminQuery);
    params.set('section', 'Tickets');
    if (debouncedSearch) params.set('q', debouncedSearch);
    else params.delete('q');
    router.push('/admin?' + params.toString(), { scroll: false });
  }, [debouncedSearch, role, adminQuery, router, searchParams]);
  useEffect(() => {
    if (role !== 'ADMIN') return;
    setActiveSection(adminSectionName(searchParams.get('section')));
    setStatusFilter(searchParams.get('status') ?? '');
    setCategoryFilter(searchParams.get('category') ?? '');
    setHallFilter(searchParams.get('hall') ?? '');
    setCreatedFrom(searchParams.get('from') ?? '');
    setCreatedTo(searchParams.get('to') ?? '');
    setListView(searchParams.get('view') === 'active' ? 'active' : 'all');
    setStallFilter(searchParams.get('stall') ?? '');
    const q = searchParams.get('q') ?? '';
    setSearch((current) => current.trim() === q || debouncedSearch === q ? current : q);
    setDebouncedSearch((current) => current === q ? current : q);
  }, [role, adminQuery, searchParams, debouncedSearch]);
  const ticketQuery = new URLSearchParams({
    view: role === 'ADMIN' ? listView : 'all',
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(categoryFilter ? { category: categoryFilter } : {}),
    ...(hallFilter ? { hallId: hallFilter } : {}),
    ...(stallFilter ? { stallId: stallFilter } : {}),
    ...(createdFrom ? { createdFrom: new Date(createdFrom).toISOString() } : {}),
    ...(createdTo ? { createdTo: new Date(createdTo).toISOString() } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  }).toString();
  const adminOnTickets = role !== 'ADMIN' || searchParams.get('section') === 'Tickets';
  const { items, total, nextCursor, loading, error: loadError, stale: ticketsStale, refresh, loadMore, connection, lastUpdatedAt } = useApiTickets(ticketQuery, { enabled: adminOnTickets });
  const [adminConnection, setAdminConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  useEffect(() => {
    if (role !== 'ADMIN') return;
    return subscribeRealtime({ onConnection: setAdminConnection, onTicket: () => undefined });
  }, [role]);
  const [subtypeFilter, setSubtypeFilter] = useState('');
  const queueQuery = new URLSearchParams({
    view: 'queued',
    limit: '50',
    ...(categoryFilter ? { category: categoryFilter } : {}),
    ...(subtypeFilter ? { subtype: subtypeFilter } : {}),
    ...(hallFilter ? { hallId: hallFilter } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  }).toString();
  const attentionQuery = 'view=attention&limit=50';
  const managerLists = role === 'HALL_MANAGER';
  const { items: queuedItems, total: queueTotal, nextCursor: queueCursor, loading: queueLoading, error: queueError, stale: queueStale, refresh: refreshQueue, loadMore: loadMoreQueue } = useApiTickets(queueQuery, { enabled: managerLists });
  const { items: attentionSource, total: attentionTotal, nextCursor: attentionCursor, loading: attentionLoading, error: attentionError, stale: attentionStale, refresh: refreshAttention, loadMore: loadMoreAttention } = useApiTickets(attentionQuery, { enabled: managerLists });
  const [timings, setTimings] = useState<Record<string, TimingRecord>>({});
  const [liveMetrics, setLiveMetrics] = useState<OperationalMetrics>({});
  const [metricsStale, setMetricsStale] = useState(false);
  const [detail, setDetail] = useState<TicketDetail>();
  const [managementError, setManagementError] = useState('');
  const [notifications, setNotifications] = useState<Array<{ id: string; type: string; readAt: string | null; sentAt: string; ticketId?: string | null; payload?: { summary?: string } | null }>>([]);
  const [managerToast, setManagerToast] = useState<{ text: string; ticketId?: string | null } | null>(null);
  const seenManagerAlerts = useRef(new Set<string>());
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelStamp = useRef(0);
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
  const [masterForm, setMasterForm] = useState<'hall' | 'zone' | null>(null);
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
  const [activeSection, setActiveSection] = useState(role === 'ADMIN' ? adminSectionName(searchParams.get('section')) : navByRole[role][0]);
  const [exceptions, setExceptions] = useState<Ticket[]>([]);
  const [auditTicketQuery, setAuditTicketQuery] = useState('');
  const [auditActionQuery, setAuditActionQuery] = useState('');
  const auditHistory = useAuditHistory(role === 'ADMIN' && activeSection === 'Audit', auditTicketQuery, auditActionQuery);
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
    setMasters([]);
    setExports([]);
  });
  const title = role === 'HALL_MANAGER' ? (profile?.scopes[0]?.hall?.name ?? 'Hall') + ' operations' : activeSection;
  const showLive = activeSection === 'Tickets';
  const eventName = profile?.scopes[0]?.event.name ?? 'EveOps event';
  const hallOptions = liveMetrics.halls ?? [];
  const filtersActive = Boolean(statusFilter || categoryFilter || subtypeFilter || hallFilter || createdFrom || createdTo || search);
  const scopedHallCount = new Set((profile?.scopes ?? []).flatMap((scope) => scope.hall?.id ? [scope.hall.id] : [])).size;
  const subtypeChoices = categoryFilter === 'ELECTRICAL' ? ['Lighting', 'NCP'] : categoryFilter === 'HOUSE_HELP' || categoryFilter === 'HALL_MANAGER' ? ['General'] : [];

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
    setSelected((current) => current ? items.find((ticket) => ticket.id === current.id) ?? current : null);
  }, [items, attentionSource, queuedItems, role]);

  useEffect(() => {
    if (role !== 'ADMIN' || searchParams.get('section') !== 'Tickets') return;
    const ticketId = searchParams.get('ticket');
    if (!ticketId) return;
    const listed = items.find((ticket) => ticket.id === ticketId);
    if (listed) {
      setSelected((current) => current?.id === listed.id ? current : listed);
      return;
    }
    let cancelled = false;
    void apiFetch('/api/tickets/' + encodeURIComponent(ticketId), { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = await response.json() as ApiTicket;
        if (body.id && body.publicNo && body.hall && body.stall) setSelected(mapTicket(body));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [role, adminQuery, items, searchParams]);

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
      if (metricResponse.status === 401 || timingResponse.status === 401) {
        setManagementError('Session expired');
        return;
      }
      if (metricResponse.ok) {
        setLiveMetrics(await metricResponse.json() as OperationalMetrics);
        setMetricsStale(false);
      } else {
        setMetricsStale(true);
        errors.push(metricResponse.status === 429 ? 'Live metrics are busy right now. Showing the last loaded summary.' : metricResponse.status === 403 ? 'You no longer have access to these figures.' : 'Live metrics are unavailable');
      }
      if (timingResponse.ok) {
        const values = await timingResponse.json() as TimingRecord[];
        setTimings(Object.fromEntries(values.map((value) => [value.id, value])));
      } else {
        setMetricsStale(true);
        errors.push(timingResponse.status === 429 ? 'Timing data is busy right now. Showing the last loaded timing.' : timingResponse.status === 403 ? 'You no longer have access to timing data.' : 'Timing data is unavailable');
      }
      if (errors.length) setManagementError(errors.join(' '));
    } catch {
      setMetricsStale(true);
      setManagementError('Management APIs are unavailable. Showing the last loaded summary.');
    }
  }, [reportRange, reportFrom, reportTo]);
  useEffect(() => { void loadManagement(); }, [loadManagement]);
  const metricsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metricsStamp = useRef(0);
  useEffect(() => {
    const section = searchParams.get('section');
    if (role === 'ADMIN' && section && !['Overview', 'Reports'].includes(section)) return;
    if (!lastUpdatedAt || metricsTimer.current) return;
    const elapsed = Date.now() - metricsStamp.current;
    const wait = metricsStamp.current === 0 ? 0 : Math.max(0, 8000 - elapsed);
    metricsTimer.current = setTimeout(() => {
      metricsTimer.current = null;
      metricsStamp.current = Date.now();
      void loadManagement();
    }, wait);
  }, [lastUpdatedAt, loadManagement, role, searchParams]);

  useEffect(() => {
    async function loadOperationalPanels() {
      const requests = [
        apiFetch('/api/workforce', { credentials: 'include', cache: 'no-store' }),
        apiFetch('/api/management/exceptions', { credentials: 'include', cache: 'no-store' }),
        ...(role === 'ADMIN' ? [apiFetch('/api/workforce/pending', { credentials: 'include', cache: 'no-store' })] : []),
      ];
      const responses = await Promise.all(requests);
      if (responses[0].ok) setWorkforce(await responses[0].json() as typeof workforce);
      if (responses[1].ok) setExceptions(((await responses[1].json()) as ApiTicket[]).map(mapTicket));
      if (role === 'ADMIN' && responses[2]?.ok) setPendingApprovals(await responses[2].json() as typeof pendingApprovals);
    }
    if (panelTimer.current) return;
    const elapsed = Date.now() - panelStamp.current;
    const wait = panelStamp.current === 0 ? 0 : Math.max(0, 8000 - elapsed);
    panelTimer.current = setTimeout(() => {
      panelTimer.current = null;
      panelStamp.current = Date.now();
      void loadOperationalPanels().catch(() => setManagementError('Operational panels could not be loaded. Showing the last loaded records.'));
    }, wait);
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
    if (role !== 'ADMIN') return;
    if (!exports.some((job) => job.status === 'PENDING' || job.status === 'PROCESSING')) return;
    const timer = window.setTimeout(() => {
      void apiFetch('/api/management/exports', { credentials: 'include', cache: 'no-store' }).then(async (response) => {
        if (response.status === 429) return;
        if (response.ok) setExports(await response.json() as typeof exports);
      });
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [role, exports]);

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

  const notificationStamp = useRef(0);
  useEffect(() => {
    if (role === 'ADMIN' && notificationStamp.current) return;
    if (role === 'HALL_MANAGER' && lastUpdatedAt && Date.now() - notificationStamp.current < 8000) return;
    notificationStamp.current = Date.now();
    void apiFetch('/api/notifications', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 429) return;
        if (!response.ok) return;
        const rows = await response.json() as typeof notifications;
        setNotifications(rows);
        if (role !== 'HALL_MANAGER') return;
        const fresh = rows.find((row) => !row.readAt && ['TICKET_CREATED', 'TICKET_REOPENED'].includes(row.type) && !seenManagerAlerts.current.has(row.id) && Date.now() - new Date(row.sentAt).getTime() < 120000);
        if (!fresh) return;
        for (const row of rows) seenManagerAlerts.current.add(row.id);
        setManagerToast({ text: fresh.payload?.summary ?? (fresh.type === 'TICKET_REOPENED' ? 'Ticket opened again' : 'New request'), ticketId: fresh.ticketId });
      })
      .catch(() => undefined);
  }, [lastUpdatedAt, role]);
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
    if (!response.ok) {
      setManagementError('Export could not be queued');
      return;
    }
    setManagementError('Export queued. It will appear in Reports when ready.');
    const jobs = await apiFetch('/api/management/exports', { credentials: 'include', cache: 'no-store' });
    if (jobs.ok) setExports(await jobs.json() as typeof exports);
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
    } else {
      body.hallId = String(values.get('hallId') ?? '');
      body.code = String(values.get('code') ?? '').trim();
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
    if (password.length < NEW_PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_BYTES || !NEW_PASSWORD_PATTERN.test(password)) {
      setPersonFormError(`Temporary password must be ${NEW_PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_BYTES} characters and include a letter and a number.`);
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
      activityOpen={role === 'HALL_MANAGER' || role === 'ADMIN'}
      onBack={role === 'HALL_MANAGER' ? () => setSelected(null) : () => { setSelected(null); const params = new URLSearchParams(searchParams.toString()); params.delete('ticket'); router.push('/admin?' + params.toString(), { scroll: false }); }}
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
      <aside className={role === 'HALL_MANAGER' ? 'sidebar hall-manager' : 'sidebar admin'}>
        <div className="brand"><span>E</span>EveOps</div>
        <nav aria-label={role === 'ADMIN' ? 'Admin navigation' : 'Hall Manager navigation'}>
          {navByRole[role].map((item) => item === 'Registrations' ? <Link key={item} href="/admin/registrations">Registrations</Link> : <button className={activeSection === item ? 'active' : ''} aria-current={activeSection === item ? 'page' : undefined} onClick={() => { setActiveSection(item); if (role === 'ADMIN') { const params = new URLSearchParams(searchParams.toString()); params.set('section', item); router.push('/admin?' + params.toString(), { scroll: false }); } if (role === 'HALL_MANAGER') { setSelected(null); window.scrollTo({ top: 0 }); } }} key={item}>{item}{item === 'Attention' && attentionTotal > 0 ? <i>{attentionTotal}</i> : null}{item === 'Workforce' && role === 'ADMIN' && pendingApprovals.length > 0 && <i>{pendingApprovals.length}</i>}</button>)}
        </nav>
        <div className="user"><span>{role === 'ADMIN' ? 'AD' : 'HM'}</span><div><strong>{profile?.name ?? (role === 'ADMIN' ? 'Event Admin' : 'Hall Manager')}</strong><small>{role.replace('_', ' ')}</small></div></div>
        <LogoutButton />
      </aside>
      <main className="management">
        <header className="topbar"><div><span className="eyebrow">{eventName} · {role === 'ADMIN' ? 'This event' : (profile?.scopes[0]?.hall?.name ?? 'Hall')} · {({ connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting' } as const)[role === 'ADMIN' ? adminConnection : connection]}</span><h1>{title}</h1></div><div className="top-actions">{profileState.error && !profile ? <span role="alert">{profileState.error}</span> : null}{profileState.stale ? <span role="status">Account details are showing the last loaded copy.</span> : null}<span>{role === 'ADMIN' ? 'All halls in this event' : (profile?.scopes[0]?.hall?.name ?? 'Hall')}</span><button onClick={() => void loadNotifications()}>Notifications · {notifications.filter((notification) => !notification.readAt).length}</button></div></header>
        {role === 'HALL_MANAGER' && profile?.id ? <WorkAlertHost userId={profile.id} /> : null}
        {managerToast && <div className="alert-line" role="status"><span>{managerToast.text}</span><button type="button" onClick={() => void openManagerAlert(managerToast)}>Open</button><button type="button" onClick={() => setManagerToast(null)}>Dismiss</button></div>}
        {managementError && <div className={managementStatusIsSuccess(managementError) ? 'alert-line' : 'form-error'} role="status">{managementError}</div>}
        {showNotifications && <section className="notification-panel">{notifications.length ? notifications.slice(0, 10).map((notification) => <button key={notification.id} onClick={() => void apiFetch('/api/notifications/' + notification.id + '/read', { method: 'PATCH', credentials: 'include' }).then(() => loadNotifications())}><strong>{notification.type.replaceAll('_', ' ')}</strong><span>{eventTime(notification.sentAt)}</span></button>) : <p className="empty-state">No notifications.</p>}</section>}
        {role === 'ADMIN' && activeSection === 'Overview' && <section aria-label="Event overview"><div className="section-title"><div><h2>Event summary</h2><p>Counts for {eventName}. Open a figure to see the records it describes. A dash means the figure has not loaded.</p></div></div><section className="metric-grid" aria-label="Operational metrics">{[
          { label: 'Open now', value: String(liveMetrics.open ?? '—'), detail: 'Not closed or cancelled', patch: { section: 'Tickets', view: 'active', status: '' } },
          { label: 'Queued', value: String(liveMetrics.queued ?? '—'), detail: 'Waiting for staff', patch: { section: 'Tickets', view: '', status: 'QUEUED' } },
          { label: 'Response overdue', value: String(liveMetrics.overdue ?? '—'), detail: 'Assignments past the response target', patch: null },
          { label: 'Escalated', value: String(liveMetrics.escalated ?? '—'), detail: 'Status is escalated', patch: { section: 'Tickets', view: '', status: 'ESCALATED' } },
          { label: 'Complaints', value: String(liveMetrics.complaints ?? '—'), detail: 'Unresolved complaints', patch: null },
          { label: 'Closed today', value: String(liveMetrics.closedToday ?? '—'), detail: 'Closed since midnight in the event timezone. Review closed tickets lists every closed ticket, which is a wider set than today.', patch: { section: 'Tickets', view: '', status: 'CLOSED' }, action: 'Review closed tickets' },
        ].map((metric) => <article key={metric.label} className="metric"><span>{metric.label}</span><strong>{metric.value}</strong><small>{metricsStale ? 'Last loaded' : metric.detail}</small>{metric.patch ? <button type="button" onClick={() => { const params = new URLSearchParams(); Object.entries(metric.patch ?? {}).forEach(([key, value]) => { if (value) params.set(key, value); }); router.push('/admin?' + params.toString(), { scroll: false }); }}>{metric.action ?? 'Review records'}</button> : <small>No single ticket filter matches this count.</small>}</article>)}</section>{(liveMetrics.halls ?? []).length ? <section className="portfolio-list" aria-label="Halls"><div className="section-title"><div><h2>Halls</h2><p>Open work in each hall. Review records opens that hall’s tickets.</p></div></div>{liveMetrics.halls?.map((hall) => <article key={hall.id}><div><strong>{hall.name}</strong><span>{hall.code}</span></div><div><span>Open</span><strong>{hall.open}</strong></div><div><span>Queued</span><strong>{hall.queued}</strong></div><div><span>Overdue</span><strong>{hall.overdue}</strong></div><button type="button" onClick={() => router.push('/admin?section=Tickets&hall=' + encodeURIComponent(hall.id) + '&view=active', { scroll: false })}>Review hall tickets</button></article>)}</section> : <p className="empty-state">Hall figures appear when the summary loads.</p>}<p className="exhibitor-note"><Link href="/admin/registrations">Registrations</Link> are stall and exhibitor accounts. Workforce approvals stay in Workforce.</p></section>}
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
              <label>User ID<span aria-hidden="true"> *</span><input name="email" type="text" required autoComplete="username" minLength={2} maxLength={254} spellCheck={false} /></label>
              <label>Phone<input name="phone" autoComplete="tel" /></label>
              <label>Temporary password<span aria-hidden="true"> *</span><input name="password" type="password" required minLength={NEW_PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_BYTES} pattern={NEW_PASSWORD_PATTERN.source} title="Use at least 8 characters, including a letter and a number" autoComplete="new-password" /><span className="otp-hint">Must be changed on first sign-in.</span></label>
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
                <p className="form-error" role="alert">No hall is available in your scope. Add a hall in Event setup before creating staff.</p>
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
          })()}{visibleWorkforce.length ? visibleWorkforce.map((membership) => <article key={membership.user.id + membership.pool.category + membership.pool.subtype}><div><strong>{membership.user.name}</strong><span>{membership.user.role === 'HALL_MANAGER' ? 'Hall manager' : 'Staff'} · {serviceLabel(membership.pool.category)} · {membership.pool.subtype}</span><span>{masters.flatMap((event) => event.halls).find((hall) => hall.id === membership.pool.hallId)?.name ?? 'Event scope'}{membership.user.employeeCode ? ` · ${membership.user.employeeCode}` : ''}</span>{membership.user.email ? <span>{membership.user.email}</span> : null}</div><div><span>Duty</span><strong>{membership.availability.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())}</strong></div><div><span>Load</span><strong>{membership.activeAssignmentCount ?? membership.activeCount ?? 0}/{membership.capacity ?? 1}</strong></div><div><span>Approval</span><strong>{(membership.user.approvalStatus ?? 'APPROVED').replaceAll('_', ' ')}</strong></div><div><span>Account</span><strong>{membership.user.status ?? 'ACTIVE'}</strong></div>{membership.user.rejectionReason && <div><span>Rejection</span><strong>{membership.user.rejectionReason}</strong></div>}{role === 'ADMIN' && membership.user.approvalStatus === 'PENDING_APPROVAL' && <div className="drawer-actions"><button className="primary" type="button" onClick={() => void approvePerson(membership.user.id)}>Approve</button><button className="critical-button" type="button" onClick={() => void rejectPerson(membership.user.id)}>{rejectUserId === membership.user.id ? 'Confirm reject' : 'Reject'}</button></div>}{rejectUserId === membership.user.id && <form className="authority-action" onSubmit={(event) => { event.preventDefault(); void rejectPerson(membership.user.id); }}><label>Rejection reason<span aria-hidden="true"> *</span><input value={rejectReason} onChange={(change) => setRejectReason(change.target.value)} required minLength={3} /></label>{rejectError && <p className="form-error" role="alert">{rejectError}</p>}<div className="drawer-actions"><button type="button" onClick={() => { setRejectUserId(null); setRejectError(''); }}>Cancel</button><button className="critical-button" type="submit">Submit rejection</button></div></form>}<div className="drawer-actions">{capacityEditUserId === membership.user.id ? <form className="authority-action" onSubmit={(event) => { event.preventDefault(); const nextCapacity = Number(capacityValue); if (Number.isInteger(nextCapacity) && nextCapacity >= 1) void updatePersonCapacity(membership.user.id, nextCapacity); }}><label>Capacity<span aria-hidden="true"> *</span><input type="number" min={1} max={20} value={capacityValue} onChange={(change) => setCapacityValue(change.target.value)} required /></label><div className="drawer-actions"><button type="button" onClick={() => setCapacityEditUserId(null)}>Cancel</button><button className="primary" type="submit">Save capacity</button></div></form> : <button type="button" onClick={() => { setCapacityEditUserId(membership.user.id); setCapacityValue(String(membership.capacity ?? 1)); }}>Edit capacity</button>}<button type="button" onClick={() => void updatePersonStatus(membership.user.id, membership.user.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED')}>{membership.user.status === 'DISABLED' ? 'Activate' : 'Deactivate'}</button></div></article>) : <p className="empty-state">No workforce identities match this filter.</p>}</section>;
        })()}
        {activeSection === 'Exceptions' && <section className="portfolio-list"><div className="section-title"><div><h2>Exception inbox</h2><p>Queued, overdue, complaint, reopened, and escalated tickets</p></div></div>{exceptions.length ? exceptions.map((ticket) => <div key={ticket.id}><TicketCard ticket={ticket} /><div className="drawer-actions"><button type="button" onClick={() => { setSelected(ticket); setActiveSection('Tickets'); }}>Open ticket</button></div></div>) : <p className="empty-state">No unresolved exceptions.</p>}</section>}
        {activeSection === 'Audit' && <section className="portfolio-list"><div className="section-title"><div><h2>Administrative history</h2><p>Registration, workforce, configuration, and ticket lifecycle events for {eventName}. Ticket activity for one request stays on that ticket. This list cannot be edited. Refresh shows records added since this page was opened. Load more continues older records. Showing {auditHistory.items.length}.</p></div><div className="drawer-actions"><label>Ticket or account<input aria-label="Audit ticket" value={auditTicketQuery} onChange={(event) => setAuditTicketQuery(event.target.value)} /></label><label>Action<input aria-label="Audit action" value={auditActionQuery} onChange={(event) => setAuditActionQuery(event.target.value)} /></label><button type="button" onClick={() => void auditHistory.refresh()}>Refresh</button></div></div>{auditHistory.stale && auditHistory.error ? <p className="alert-line" role="status">{auditHistory.error}</p> : null}{!auditHistory.loaded ? <p className="empty-state">Loading history…</p> : auditHistory.error && !auditHistory.items.length ? <p className="form-error" role="alert">{auditHistory.error}</p> : auditHistory.items.length ? <>{auditHistory.items.map((event) => <article key={(event.kind ?? 'ticket') + event.id}><div><strong>{event.ticket.publicNo}</strong><span>{event.actor?.name ?? 'System'}{event.actor?.role ? ` · ${event.actor.role.replaceAll('_', ' ')}` : ''}</span></div><div><span>Record</span><strong>{event.kind === 'workforce' ? 'Administrative change' : 'Ticket lifecycle'}</strong></div><div><span>Action</span><strong>{event.eventType.replaceAll('_', ' ')}</strong></div><div><span>Server time</span><strong>{eventTime(event.createdAt)}</strong></div></article>)}{auditHistory.nextCursor ? <button type="button" onClick={() => void auditHistory.loadMore()}>Load more</button> : null}</> : <p className="empty-state">No history matches this search.</p>}</section>}
        {activeSection === 'Event setup' && <section className="portfolio-list"><div className="section-title"><div><h2>Event setup</h2><p>Halls, zones, and service timing for {eventName}. Stall records and exhibitor logins are created in Registrations, so saving a stall here cannot be mistaken for creating a login.</p></div><div className="drawer-actions"><button type="button" onClick={() => { setMasterForm(masterForm === 'hall' ? null : 'hall'); setMasterFormError(''); }}>Add hall</button><button type="button" onClick={() => { setMasterForm(masterForm === 'zone' ? null : 'zone'); setMasterFormError(''); }}>Add zone</button><Link href="/admin/registrations">Open registrations</Link></div></div>
          {masterForm === 'hall' && <form className="authority-action" onSubmit={(event) => void createMaster(event)}><label>Hall code<span aria-hidden="true"> *</span><input name="code" required minLength={1} /></label><label>Hall name<span aria-hidden="true"> *</span><input name="name" required minLength={1} /></label><label>Status<select name="status" defaultValue="ACTIVE"><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>{masterFormError && <p className="form-error" role="alert">{masterFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setMasterForm(null)}>Cancel</button><button className="primary" type="submit" disabled={masterSubmitting}>{masterSubmitting ? 'Saving…' : 'Create hall'}</button></div></form>}
          {masterForm === 'zone' && <form className="authority-action" onSubmit={(event) => void createMaster(event)}><label>Hall<span aria-hidden="true"> *</span><select name="hallId" required>{masters.flatMap((event) => event.halls).map((hall) => <option key={hall.id} value={hall.id}>{hall.name}</option>)}</select></label><label>Zone code<span aria-hidden="true"> *</span><input name="code" required minLength={1} /></label>{masterFormError && <p className="form-error" role="alert">{masterFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setMasterForm(null)}>Cancel</button><button className="primary" type="submit" disabled={masterSubmitting}>{masterSubmitting ? 'Saving…' : 'Create zone'}</button></div></form>}
          {!masters.length ? <p className="empty-state">No master hierarchy is available for your event scope.</p> : masters.map((event) => <div key={event.id}><article><div><strong>{event.name}</strong><span>{event.timezone ? `Timezone ${event.timezone}` : 'Event masters'}</span></div><div><span>Halls</span><strong>{event.halls.length}</strong></div><div><span>Zones</span><strong>{event.halls.reduce((sum, hall) => sum + hall.zones.length, 0)}</strong></div><div><span>Stalls</span><strong>{event.halls.reduce((sum, hall) => sum + hall.zones.reduce((zoneSum, zone) => zoneSum + zone.stalls.length, 0), 0)}</strong></div></article>{event.halls.map((hall) => <article key={hall.id}><div><strong>{hall.name}</strong><span>{hall.zones.length} zones · {hall.zones.reduce((sum, zone) => sum + zone.stalls.length, 0)} stalls</span></div><div><span>Zones</span><strong>{hall.zones.map((zone) => zone.code).join(', ') || 'None'}</strong></div><div><span>Stalls</span><strong>{hall.zones.flatMap((zone) => zone.stalls.map((stall) => stall.stallCode)).join(', ') || 'None'}</strong></div></article>)}{event.pools.map((pool) => <article key={pool.id}><div><strong>{pool.category} · {pool.subtype}</strong><span>{pool.active ? 'Active' : 'Inactive'}</span></div><div><span>Response SLA</span><strong>{duration(pool.responseTargetSeconds)}</strong></div><div><span>Resolution SLA</span><strong>{duration(pool.resolutionTargetSeconds)}</strong></div>{slaEditPoolId === pool.id ? <form className="authority-action" onSubmit={(formEvent) => void updatePool(formEvent, pool)}><label>Response target (seconds)<span aria-hidden="true"> *</span><input name="responseTargetSeconds" type="number" min={1} required defaultValue={pool.responseTargetSeconds} /></label><label>Resolution target (seconds)<span aria-hidden="true"> *</span><input name="resolutionTargetSeconds" type="number" min={1} required defaultValue={pool.resolutionTargetSeconds} /></label>{slaFormError && <p className="form-error" role="alert">{slaFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setSlaEditPoolId(null)}>Cancel</button><button className="primary" type="submit" disabled={slaSubmitting}>{slaSubmitting ? 'Saving…' : 'Save SLA'}</button></div></form> : <button type="button" onClick={() => { setSlaEditPoolId(pool.id); setSlaFormError(''); }}>Edit SLA</button>}</article>)}</div>)}</section>}
        {(activeSection === 'Reports') && <section className="portfolio-list"><div className="section-title"><div><h2>Reports</h2><p>Figures below use tickets created in the selected range, inside {eventName}. Open is not closed or cancelled. Queued is waiting for staff. Response overdue counts assignments past the response target. Resolution and response averages use completed timestamps only; a dash means there is no completed sample. CSV export uses the ticket filters currently selected on Tickets, not a separate definition.</p></div><div className="drawer-actions"><label className="sr-only" htmlFor="report-range">Report range</label><select id="report-range" aria-label="Report range" value={reportRange} onChange={(event) => setReportRange(event.target.value as 'live' | 'today' | 'custom')}><option value="live">All tickets in scope</option><option value="today">Created today</option><option value="custom">Custom range</option></select>{reportRange === 'custom' && <><label className="sr-only" htmlFor="report-from">From</label><input id="report-from" aria-label="Report from" type="datetime-local" value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} /><label className="sr-only" htmlFor="report-to">To</label><input id="report-to" aria-label="Report to" type="datetime-local" value={reportTo} onChange={(event) => setReportTo(event.target.value)} /></>}<button type="button" onClick={() => void exportView()}>Queue CSV export</button></div></div><CommandInsights metrics={liveMetrics} />{exports.length ? exports.map((job) => <article key={job.id}><div><strong>{job.format}</strong><span>{eventTime(job.createdAt)}</span></div><div><span>Status</span><strong>{job.status}</strong></div><div><span>Rows</span><strong>{job.rowCount ?? 'Pending'}</strong></div>{job.status === 'READY' && <a href={'/api/management/exports/' + job.id + '/download'}>Download</a>}</article>) : <p className="empty-state">No export jobs yet. Queue a CSV from Tickets or from this page.</p>}</section>}
        {role === 'HALL_MANAGER' && activeSection === 'Attention' && <section className={selected ? 'workspace manager-focus' : 'workspace'} aria-label="Needs attention">
          <div className="operations">
            <div className="section-title"><div><h2>Needs attention</h2><p>{attentionTotal} in this hall. Newly raised, reopened, complained, escalated, urgent, overdue, waiting for a completion code, or assigned and not yet started. Ordinary waiting tickets stay in Queue. Showing {attentionItems.length}.</p></div></div>
            {attentionStale && attentionError ? <p className="alert-line" role="status">{attentionError}</p> : null}
            {attentionLoading && !attentionItems.length ? <p className="empty-state">Loading work that needs attention…</p> : attentionError && !attentionItems.length ? <p className="form-error" role="alert">{attentionError}</p> : attentionTotal === 0 ? <p className="empty-state">Nothing needs attention right now.</p> : <div className="manager-list">{attentionItems.map((ticket) => <button type="button" key={ticket.id} className={selected?.id === ticket.id ? 'manager-card selected' : 'manager-card'} onClick={() => setSelected(ticket)}><strong>{attentionReason(ticket) ?? 'Needs attention'}</strong><span>{ticket.location}</span><span>{ticket.service}</span><span>{ticket.no} · {statusLabels[ticket.status]}</span><span>Next: {managerNextStep(ticket)}</span></button>)}</div>}{attentionCursor && <button type="button" onClick={() => void loadMoreAttention()}>Load more</button>}
          </div>
          {ticketPanel}
        </section>}
        {role === 'HALL_MANAGER' && activeSection === 'Queue' && <section className={selected ? 'workspace manager-focus' : 'workspace'} aria-label="Waiting queue">
          <div className="operations">
            <div className="section-title"><div><h2>Waiting queue</h2><p>{queueTotal} waiting · moved-ahead tickets, then high, medium, and low stall priority, then oldest. Urgency does not change this order. Assigned work stays with the worker. Showing {queuedItems.length}. A scheduling position is the rank in one hall, one service, and one subtype. Combined services, subtypes, halls, or a search show Waiting.</p></div></div>
            <div className="filters"><select aria-label="Queue service" value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); setSubtypeFilter(''); }}><option value="">All services</option><option value="ELECTRICAL">Electrical</option><option value="HOUSE_HELP">House Help</option><option value="HALL_MANAGER">Hall Manager</option></select>{subtypeChoices.length > 0 && <select aria-label="Queue subtype" value={subtypeFilter} onChange={(event) => setSubtypeFilter(event.target.value)}><option value="">All subtypes</option>{subtypeChoices.map((subtype) => <option key={subtype} value={subtype}>{subtype}</option>)}</select>}{hallOptions.length > 1 && <select aria-label="Queue hall" value={hallFilter} onChange={(event) => setHallFilter(event.target.value)}><option value="">All halls</option>{hallOptions.map((hall) => <option key={hall.id} value={hall.id}>{hall.code} · {hall.name}</option>)}</select>}<label className="sr-only" htmlFor="queue-search">Find a waiting ticket</label><input id="queue-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Ticket number or stall" />{(categoryFilter || subtypeFilter || hallFilter || search) && <button type="button" onClick={() => { setCategoryFilter(''); setSubtypeFilter(''); setHallFilter(''); setSearch(''); }}>Clear filters</button>}</div>
            {queueStale && queueError ? <p className="alert-line" role="status">{queueError}</p> : null}
            {queueLoading && !queuedItems.length ? <p className="empty-state">Loading the waiting queue…</p> : queueError && !queuedItems.length ? <p className="form-error" role="alert">{queueError}</p> : !queuedItems.length ? <p className="empty-state">{categoryFilter || hallFilter || search || subtypeFilter ? 'No waiting tickets match this search.' : 'No tickets are waiting in the queue.'}</p> : <><div className="manager-list">{queuedItems.map((ticket, index) => <button type="button" key={ticket.id} className={selected?.id === ticket.id ? 'manager-card selected' : 'manager-card'} onClick={() => setSelected(ticket)}><span className="eyebrow">{schedulingQueueLabel({ index, search, category: categoryFilter, subtype: subtypeFilter, hallId: hallFilter, scopedHallCount })}</span><strong>{ticket.no} · Stall {ticket.locationParts.stall}</strong><span>{ticket.location}</span><span>{ticket.service} · {statusLabels[ticket.status]}</span><span>{ticket.queuePriorityOverrideAt ? 'Moved ahead' : `${ticket.servicePriority ?? 'MEDIUM'} stall priority`}{ticket.priority ? ' · Urgent' : ''}</span></button>)}</div>{queueCursor && <button type="button" onClick={() => void loadMoreQueue()}>Load more</button>}</>}
          </div>
          {ticketPanel}
        </section>}
        {showLive && <section className={role === 'HALL_MANAGER' && selected ? 'workspace manager-focus' : 'workspace'}>
          <div className="operations">
            <div className="section-title"><div><h2>Tickets</h2><p>{role === 'HALL_MANAGER' ? `${total} tickets in this hall. Open one for the full activity log.` : `${total} tickets in ${eventName}. Showing ${items.length}. Open a row for activity and actions. Export uses these filters.`}</p></div>{role === 'ADMIN' && <button onClick={() => void exportView()}>Export this filter</button>}</div>
            <div className="filters"><select aria-label="Status filter" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); if (role === 'ADMIN') { const params = new URLSearchParams(searchParams.toString()); params.set('section', 'Tickets'); if (event.target.value) params.set('status', event.target.value); else params.delete('status'); router.push('/admin?' + params.toString(), { scroll: false }); } }}><option value="">All statuses</option>{Object.keys(statusLabels).map((status) => <option key={status} value={status}>{statusLabels[status as TicketStatus]}</option>)}</select><select aria-label="Service filter" value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); if (role === 'ADMIN') { const params = new URLSearchParams(searchParams.toString()); params.set('section', 'Tickets'); if (event.target.value) params.set('category', event.target.value); else params.delete('category'); router.push('/admin?' + params.toString(), { scroll: false }); } }}><option value="">All services</option><option value="ELECTRICAL">Electrical</option><option value="HOUSE_HELP">House Help</option><option value="HALL_MANAGER">Hall Manager</option></select>{hallOptions.length > 1 && <select aria-label="Hall filter" value={hallFilter} onChange={(event) => { setHallFilter(event.target.value); if (role === 'ADMIN') { const params = new URLSearchParams(searchParams.toString()); params.set('section', 'Tickets'); if (event.target.value) params.set('hall', event.target.value); else params.delete('hall'); router.push('/admin?' + params.toString(), { scroll: false }); } }}><option value="">All halls</option>{hallOptions.map((hall) => <option key={hall.id} value={hall.id}>{hall.code} · {hall.name}</option>)}</select>}<label className="sr-only" htmlFor="created-from">Created from</label><input id="created-from" aria-label="Created from" type="datetime-local" value={createdFrom} onChange={(event) => { setCreatedFrom(event.target.value); if (role === 'ADMIN') { const params = new URLSearchParams(searchParams.toString()); params.set('section', 'Tickets'); if (event.target.value) params.set('from', event.target.value); else params.delete('from'); router.push('/admin?' + params.toString(), { scroll: false }); } }} /><label className="sr-only" htmlFor="created-to">Created to</label><input id="created-to" aria-label="Created to" type="datetime-local" value={createdTo} onChange={(event) => { setCreatedTo(event.target.value); if (role === 'ADMIN') { const params = new URLSearchParams(searchParams.toString()); params.set('section', 'Tickets'); if (event.target.value) params.set('to', event.target.value); else params.delete('to'); router.push('/admin?' + params.toString(), { scroll: false }); } }} /><label className="sr-only" htmlFor="ticket-search">Search tickets</label><input id="ticket-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search ticket or stall" autoFocus={role === 'ADMIN' && activeSection === 'Tickets'} />{filtersActive && <button type="button" onClick={() => { setStatusFilter(''); setCategoryFilter(''); setSubtypeFilter(''); setHallFilter(''); setCreatedFrom(''); setCreatedTo(''); setSearch(''); if (role === 'ADMIN') router.push('/admin?section=Tickets', { scroll: false }); }}>Clear filters</button>}</div>
            {ticketsStale && loadError ? <p className="alert-line" role="status">{loadError}</p> : null}
            {loading && !items.length ? <p className="empty-state">Loading live operations…</p> : loadError && !items.length ? <p className="form-error">{loadError}</p> : !items.length ? <p className="empty-state">{filtersActive ? 'No tickets match these filters.' : 'No tickets match the current scope.'}</p> : role === 'HALL_MANAGER' ? <><div className="manager-list">{items.map((ticket) => <button type="button" key={ticket.id} className={selected?.id === ticket.id ? 'manager-card selected' : 'manager-card'} onClick={() => setSelected(ticket)}><strong>{ticket.no} · Stall {ticket.locationParts.stall}</strong><span>{ticket.location}</span><span>{ticket.service}</span><span>{statusLabels[ticket.status]} · {ticket.assignee}</span><TimingFacts ticket={ticket} /></button>)}</div>{nextCursor && <button type="button" onClick={() => void loadMore()}>Load more</button>}</> : <><div className="admin-ticket-cards">{items.map((ticket) => <button type="button" key={ticket.id} className={selected?.id === ticket.id ? 'manager-card selected' : 'manager-card'} onClick={() => { setSelected(ticket); const params = new URLSearchParams(searchParams.toString()); params.set('section', 'Tickets'); params.set('ticket', ticket.id); router.push('/admin?' + params.toString(), { scroll: false }); }}><strong>{ticket.no}</strong><span>{ticket.location}</span><span>{ticket.service}</span><span>{statusLabels[ticket.status]} · {ticket.assignee}</span></button>)}</div><div className="table-wrap admin-ticket-table"><table><thead><tr><th>Ticket</th><th>Location / issue</th><th>Status</th><th>Timing</th><th>Response</th><th>Total</th><th>Assignee</th><th>SLA</th></tr></thead><tbody>{items.map((ticket) => <tr key={ticket.no} tabIndex={0} className={selected?.no === ticket.no ? 'selected' : ''} onClick={() => { setSelected(ticket); if (role === 'ADMIN') { const params = new URLSearchParams(searchParams.toString()); params.set('section', 'Tickets'); params.set('ticket', ticket.id); router.push('/admin?' + params.toString(), { scroll: false }); } }} onKeyDown={(event) => { if (event.key === 'Enter') setSelected(ticket); }}><td><strong>{ticket.no}</strong><small>{ticket.service}</small></td><td><strong>{ticket.location}</strong><small>{ticket.description}</small></td><td><Status value={ticket.status} /></td><td className={ticket.priority ? 'red' : ''}><TimingFacts ticket={ticket} /></td><td>{duration(timings[ticket.id]?.assignToAcceptSeconds)}</td><td>{duration(timings[ticket.id]?.totalResolutionSeconds)}</td><td>{ticket.assignee}</td><td><span className={ticket.slaState === 'On track' ? 'sla' : 'sla breach'}>{ticket.slaState}</span></td></tr>)}</tbody></table></div>{nextCursor && <button type="button" onClick={() => void loadMore()}>Load more</button>}</>}
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
  const searchParams = useSearchParams();
  const router = useRouter();
  const section = ['Events', 'Tickets', 'Admins', 'Reports', 'Configuration', 'Audit'].includes(searchParams.get('section') ?? '') ? searchParams.get('section') ?? 'Overview' : 'Overview';
  const selectedEvent = searchParams.get('event') ?? '';
  const explorerStatus = searchParams.get('status') ?? '';
  const explorerCategory = searchParams.get('category') ?? '';
  const [portfolio, setPortfolio] = useState<PortfolioEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [admins, setAdmins] = useState<Array<{ id: string; name: string; email: string; status: string; scopes: Array<{ event: { name: string } }> }>>([]);
  const [auditTicket, setAuditTicket] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const governanceHistory = useAuditHistory(section === 'Audit', auditTicket, auditAction);
  const [governanceExports, setGovernanceExports] = useState<Array<{ id: string; format: string; status: string; rowCount: number | null; createdAt: string }>>([]);
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [adminFormError, setAdminFormError] = useState('');
  const [adminSubmitting, setAdminSubmitting] = useState(false);
  const [adminEventIds, setAdminEventIds] = useState<string[]>([]);
  const [openedTicket, setOpenedTicket] = useState<Ticket | null>(null);
  const [analytics, setAnalytics] = useState<OperationalMetrics>({});
  const [analyticsError, setAnalyticsError] = useState('');
  const [governanceMasters, setGovernanceMasters] = useState<Array<{ id: string; name: string; pools: Array<{ id: string; category: string; subtype: string; responseTargetSeconds: number; resolutionTargetSeconds: number; active: boolean }> }>>([]);
  const [slaPoolId, setSlaPoolId] = useState<string | null>(null);
  const [slaError, setSlaError] = useState('');
  useAuthLoss(() => {
    setPortfolio([]);
    setAdmins([]);
    setGovernanceExports([]);
    setAnalytics({});
    setGovernanceMasters([]);
  });
  const explorerQuery = new URLSearchParams({
    view: 'all',
    limit: '50',
    ...(selectedEvent ? { eventId: selectedEvent } : {}),
    ...(explorerStatus ? { status: explorerStatus } : {}),
    ...(explorerCategory ? { category: explorerCategory } : {}),
  }).toString();
  const { items: eventTickets, total: eventTicketTotal, nextCursor: eventTicketCursor, loading: ticketsLoading, loadMore: loadMoreEventTickets } = useApiTickets(explorerQuery, { enabled: section === 'Tickets' });
  function openGovernance(patch: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push('/super-admin?' + params.toString(), { scroll: false });
  }
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loadPortfolio = () => {
      void apiFetch('/api/management/portfolio', { credentials: 'include', cache: 'no-store' })
        .then(async (response) => {
          if (cancelled) return;
          if (response.status === 429) {
            setError('Event figures are busy right now.');
            timer = setTimeout(loadPortfolio, jitteredRetryMs(retryAfterMs(response.headers.get('retry-after')), Math.random()));
            return;
          }
          if (!response.ok) throw new Error('Portfolio could not be loaded');
          setPortfolio(await response.json() as PortfolioEvent[]);
          setError('');
          setLoading(false);
        })
        .catch((cause) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : 'Portfolio could not be loaded');
          setLoading(false);
        });
    };
    loadPortfolio();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    void Promise.all([
      apiFetch('/api/management/admins', { credentials: 'include', cache: 'no-store' }),
      apiFetch('/api/management/exports', { credentials: 'include', cache: 'no-store' }),
    ]).then(async ([adminResponse, exportResponse]) => {
      if (adminResponse.ok) setAdmins(await adminResponse.json() as typeof admins);
      if (exportResponse.ok) setGovernanceExports(await exportResponse.json() as typeof governanceExports);
    }).catch(() => setError('Governance data could not be loaded'));
  }, []);
  useEffect(() => {
    if (section !== 'Reports') return;
    const parameters = new URLSearchParams();
    if (selectedEvent) parameters.set('eventId', selectedEvent);
    void apiFetch('/api/management/metrics?' + parameters.toString(), { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Analytics could not be loaded');
        setAnalytics(await response.json() as OperationalMetrics);
        setAnalyticsError('');
      })
      .catch(() => setAnalyticsError('Analytics could not be loaded'));
  }, [section, selectedEvent]);
  useEffect(() => {
    if (section !== 'Configuration') return;
    void apiFetch('/api/management/masters', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (response.ok) setGovernanceMasters(await response.json() as typeof governanceMasters);
      })
      .catch(() => setError('Configuration could not be loaded'));
  }, [section]);
  const figuresReady = !loading && !error;
  const totalOpen = figuresReady ? portfolio.reduce((sum, event) => sum + event.open, 0) : null;
  const totalExceptions = figuresReady ? portfolio.reduce((sum, event) => sum + event.exceptions, 0) : null;
  const medianResponse = portfolio[0]?.portfolioMedianResponseSeconds == null ? '—' : duration(portfolio[0].portfolioMedianResponseSeconds);
  async function exportPortfolio() {
    const response = await apiFetch('/api/management/exports', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'CSV', filters: selectedEvent ? { eventId: selectedEvent } : {}, columns: [] }),
    });
    if (!response.ok) {
      setError('Portfolio export could not be queued.');
      return;
    }
    setError('Portfolio export queued.');
    const jobs = await apiFetch('/api/management/exports', { credentials: 'include', cache: 'no-store' });
    if (jobs.ok) setGovernanceExports(await jobs.json() as typeof governanceExports);
  }
  async function createAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adminSubmitting) return;
    setAdminSubmitting(true);
    setAdminFormError('');
    const values = new FormData(event.currentTarget);
    const eventIds = adminEventIds.filter((eventId) => portfolio.some((event) => event.id === eventId));
    if (!eventIds.length) {
      setAdminFormError('Choose at least one authorized event.');
      setAdminSubmitting(false);
      return;
    }
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
  const organizationName = profile?.organization?.name ?? 'Authorized organization';
  const selectedEventName = portfolio.find((event) => event.id === selectedEvent)?.event ?? 'All authorized events';
  useEffect(() => {
    const ticketId = searchParams.get('ticket');
    if (section !== 'Tickets' || !ticketId) {
      setOpenedTicket(null);
      return;
    }
    const listed = eventTickets.find((ticket) => ticket.id === ticketId);
    if (listed) {
      setOpenedTicket(listed);
      return;
    }
    let cancelled = false;
    void apiFetch('/api/tickets/' + encodeURIComponent(ticketId), { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = await response.json() as ApiTicket;
        if (body.id && body.publicNo && body.hall && body.stall) setOpenedTicket(mapTicket(body));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [section, searchParams, eventTickets]);
  return (
    <OperationalClock timeZone={profile?.scopes[0]?.event.timezone}>
    <div className="app-shell super-shell">
      <aside className="sidebar admin">
        <div className="brand"><span>E</span>EveOps</div>
        <nav aria-label="Super Admin navigation">{['Overview', 'Events', 'Tickets', 'Admins', 'Reports', 'Configuration', 'Audit'].map((item) => <button className={section === item ? 'active' : ''} aria-current={section === item ? 'page' : undefined} onClick={() => openGovernance({ section: item === 'Overview' ? null : item, ticket: null })} key={item}>{item}</button>)}</nav>
        <div className="user"><span>SA</span><div><strong>{profile?.name ?? 'Organization owner'}</strong><small>SUPER ADMIN</small></div></div>
        <LogoutButton />
      </aside>
      <main className="management">
        <header className="topbar"><div><span className="eyebrow">{organizationName} · {selectedEventName}</span><h1>{section}</h1></div><div className="top-actions"><label className="sr-only" htmlFor="governance-event">Event</label><select id="governance-event" aria-label="Event" value={selectedEvent} onChange={(event) => openGovernance({ event: event.target.value || null, ticket: null })}><option value="">All authorized events</option>{portfolio.map((event) => <option key={event.id} value={event.id}>{event.event}</option>)}</select></div></header>
        {error && <div className={error.endsWith('queued.') || error.includes('must be changed') ? 'alert-line' : 'form-error'}>{error}</div>}
        {section === 'Overview' && <section aria-label="Organization overview"><div className="section-title"><div><h2>Organization summary</h2><p>Counts include every event this account is allowed to open. Open means not closed or cancelled. Exceptions are escalated tickets and unresolved complaints. Median response uses completed acceptances only. A dash means the figure has not loaded.</p></div></div><section className="metric-grid">{[
          { label: 'Authorized events', value: figuresReady ? String(portfolio.length) : '—', detail: 'Events this account can open' },
          { label: 'Open tickets', value: totalOpen == null ? '—' : String(totalOpen), detail: 'Not closed or cancelled' },
          { label: 'Exceptions', value: totalExceptions == null ? '—' : String(totalExceptions), detail: 'Escalated or complaint status' },
          { label: 'Median response', value: figuresReady ? medianResponse : '—', detail: 'Raise to first acceptance, all authorized events' },
        ].map((metric) => <article key={metric.label} className="metric"><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small></article>)}</section><div className="drawer-actions"><button type="button" onClick={() => openGovernance({ section: 'Events' })}>Review events</button><button type="button" onClick={() => openGovernance({ section: 'Tickets' })}>Review tickets</button></div></section>}
        {section === 'Events' && <section className="portfolio-list"><div className="section-title"><div><h2>Authorized events</h2><p>{selectedEvent ? `${selectedEventName} is selected in the header.` : 'Every event this account can open. Choosing one limits tickets, reports, and exports to that event.'}</p></div></div>{loading ? <p className="empty-state">Loading authorized events…</p> : error ? <p className="form-error" role="alert">{error}</p> : visibleEvents.length ? visibleEvents.map((event) => <article key={event.id}><div><strong>{event.event}</strong><span>{event.venue}{event.status ? ` · ${event.status}` : ''}</span></div><div><span>Open</span><strong>{event.open}</strong></div><div><span>Exceptions</span><strong className={event.exceptions ? 'red' : undefined}>{event.exceptions}</strong></div><div><span>Median response</span><strong>{event.medianResponseSeconds == null ? '—' : duration(event.medianResponseSeconds)}</strong></div><button type="button" onClick={() => openGovernance({ section: 'Tickets', event: event.id })}>Open tickets</button></article>) : <p className="empty-state">No events are assigned to this account.</p>}</section>}
        {section === 'Tickets' && <section className={openedTicket ? 'workspace manager-focus' : 'workspace'}><div className="operations"><div className="section-title"><div><h2>{selectedEvent ? selectedEventName : 'Cross-event tickets'}</h2><p>{ticketsLoading && !eventTickets.length ? 'Loading authorized tickets…' : `${eventTicketTotal} authorized tickets. Showing ${eventTickets.length}.`} Open a row for activity. This account does not accept, snooze, or close work from here.</p></div></div><div className="filters"><select aria-label="Explorer status" value={explorerStatus} onChange={(event) => openGovernance({ section: 'Tickets', status: event.target.value || null, ticket: null })}><option value="">All statuses</option>{Object.keys(statusLabels).map((status) => <option key={status} value={status}>{statusLabels[status as TicketStatus]}</option>)}</select><select aria-label="Explorer service" value={explorerCategory} onChange={(event) => openGovernance({ section: 'Tickets', category: event.target.value || null, ticket: null })}><option value="">All services</option><option value="ELECTRICAL">Electrical</option><option value="HOUSE_HELP">House Help</option><option value="HALL_MANAGER">Hall Manager</option></select>{(explorerStatus || explorerCategory || selectedEvent) && <button type="button" onClick={() => openGovernance({ section: 'Tickets', status: null, category: null, event: null, ticket: null })}>Clear filters</button>}</div>{ticketsLoading && !eventTickets.length ? <p className="empty-state">Loading tickets…</p> : eventTickets.length ? <><div className="manager-list">{eventTickets.map((ticket) => <button type="button" key={ticket.id} className={openedTicket?.id === ticket.id ? 'manager-card selected' : 'manager-card'} onClick={() => openGovernance({ section: 'Tickets', ticket: ticket.id })}><strong>{ticket.no}</strong><span>{ticket.location}</span><span>{ticket.service}</span><span>{statusLabels[ticket.status]}</span></button>)}</div>{eventTicketCursor && <button type="button" onClick={() => void loadMoreEventTickets()}>Load more</button>}</> : <p className="empty-state">No tickets match this explorer.</p>}</div>{openedTicket && <aside className="drawer" aria-label={'Ticket ' + openedTicket.no + ' detail'}><button type="button" onClick={() => openGovernance({ ticket: null })}>Back to the list</button><div className="drawer-head"><div><span className="eyebrow">{openedTicket.no}</span><h2>{openedTicket.service}</h2></div><Status value={openedTicket.status} audience="manager" /></div><p>{openedTicket.location}</p><p className="description">{openedTicket.description}</p><TicketActivity ticketId={openedTicket.id} /></aside>}</section>}
        {section === 'Admins' && <section className="portfolio-list"><div className="section-title"><div><h2>Admin accounts</h2><p>Event access is chosen from the events this organization account can already open. Creating an admin does not add events or grant hall-manager actions.</p></div><button type="button" onClick={() => { setShowAddAdmin((value) => !value); setAdminFormError(''); setAdminEventIds(selectedEvent ? [selectedEvent] : []); }}>{showAddAdmin ? 'Close form' : 'Add admin'}</button></div>{showAddAdmin && <form className="authority-action" onSubmit={(event) => void createAdmin(event)}><label>Name<span aria-hidden="true"> *</span><input name="name" required minLength={2} /></label><label>User ID<span aria-hidden="true"> *</span><input name="email" type="text" required minLength={2} maxLength={254} spellCheck={false} /></label><label>Temporary password<span aria-hidden="true"> *</span><input name="password" type="password" required minLength={NEW_PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_BYTES} pattern={NEW_PASSWORD_PATTERN.source} title="Use at least 8 characters, including a letter and a number" /></label><fieldset><legend>Event access</legend>{portfolio.map((event) => <label key={event.id}><input type="checkbox" checked={adminEventIds.includes(event.id)} onChange={(change) => setAdminEventIds((current) => change.target.checked ? [...current, event.id] : current.filter((id) => id !== event.id))} /> {event.event}</label>)}</fieldset>{adminFormError && <p className="form-error" role="alert">{adminFormError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setShowAddAdmin(false)}>Cancel</button><button className="primary" type="submit" disabled={adminSubmitting}>{adminSubmitting ? 'Creating…' : 'Create admin'}</button></div></form>}{admins.length ? admins.map((admin) => <article key={admin.id}><div><strong>{admin.name}</strong><span>{admin.email}</span></div><div><span>Status</span><strong>{admin.status}</strong></div><div><span>Events</span><strong>{admin.scopes.map((scope) => scope.event.name).join(', ') || 'No event access'}</strong></div></article>) : <p className="empty-state">No admin accounts are visible in this organization.</p>}</section>}
        {section === 'Reports' && <section className="portfolio-list"><div className="section-title"><div><h2>Reports and exports</h2><p>Figures use {selectedEvent ? selectedEventName : 'every authorized event'}. Open is not closed or cancelled. Averages and medians use completed timestamps only; a dash means there is no completed sample or the figure has not loaded. CSV export uses the selected event and expires after 24 hours. An empty file still downloads when the filter matches nothing.</p></div><button type="button" onClick={() => void exportPortfolio()}>Queue CSV export</button></div>{analyticsError && <p className="form-error" role="alert">{analyticsError}</p>}<CommandInsights metrics={analytics} />{governanceExports.length ? governanceExports.map((job) => <article key={job.id}><div><strong>{job.format}</strong><span>{eventTime(job.createdAt)}</span></div><div><span>Status</span><strong>{job.status}</strong></div><div><span>Rows</span><strong>{job.rowCount ?? 'Pending'}</strong></div>{job.status === 'READY' && <a href={'/api/management/exports/' + job.id + '/download'}>Download</a>}</article>) : <p className="empty-state">No export jobs yet.</p>}</section>}
        {section === 'Audit' && <section className="portfolio-list"><div className="section-title"><div><h2>Administrative history</h2><p>Registration, workforce, configuration, and ticket lifecycle records for authorized events. This list cannot be edited. Refresh shows records added since this page was opened. Load more continues older records. Showing {governanceHistory.items.length}.</p></div><div className="drawer-actions"><label>Ticket or account<input aria-label="Audit ticket" value={auditTicket} onChange={(event) => setAuditTicket(event.target.value)} /></label><label>Action<input aria-label="Audit action" value={auditAction} onChange={(event) => setAuditAction(event.target.value)} /></label><button type="button" onClick={() => void governanceHistory.refresh()}>Refresh</button></div></div>{governanceHistory.stale && governanceHistory.error ? <p className="alert-line" role="status">{governanceHistory.error}</p> : null}{!governanceHistory.loaded ? <p className="empty-state">Loading history…</p> : governanceHistory.error && !governanceHistory.items.length ? <p className="form-error" role="alert">{governanceHistory.error}</p> : governanceHistory.items.length ? <>{governanceHistory.items.map((event) => <article key={(event.kind ?? 'ticket') + event.id}><div><strong>{event.ticket.publicNo}</strong><span>{event.actor?.name ?? 'System'}{event.actor?.role ? ` · ${event.actor.role.replaceAll('_', ' ')}` : ''}</span></div><div><span>Record</span><strong>{event.kind === 'workforce' ? 'Administrative change' : 'Ticket lifecycle'}</strong></div><div><span>Action</span><strong>{event.eventType.replaceAll('_', ' ')}</strong></div><div><span>Time</span><strong>{eventTime(event.createdAt)}</strong></div></article>)}{governanceHistory.nextCursor ? <button type="button" onClick={() => void governanceHistory.loadMore()}>Load more</button> : null}</> : <p className="empty-state">No history matches this search.</p>}</section>}
        {section === 'Configuration' && <section className="portfolio-list"><div className="section-title"><div><h2>Service configuration</h2><p>SLA defaults for authorized events. Export files expire after 24 hours.</p></div></div>{governanceMasters.length ? governanceMasters.map((event) => <div key={event.id}>{event.pools.map((pool) => <article key={pool.id}><div><strong>{event.name}</strong><span>{pool.category} · {pool.subtype} · {pool.active ? 'Active' : 'Inactive'}</span></div><div><span>Response SLA</span><strong>{duration(pool.responseTargetSeconds)}</strong></div><div><span>Resolution SLA</span><strong>{duration(pool.resolutionTargetSeconds)}</strong></div>{slaPoolId === pool.id ? <form className="authority-action" onSubmit={(formEvent) => void savePoolSla(formEvent, pool.id)}><label>Response target (seconds)<span aria-hidden="true"> *</span><input name="responseTargetSeconds" type="number" min={1} required defaultValue={pool.responseTargetSeconds} /></label><label>Resolution target (seconds)<span aria-hidden="true"> *</span><input name="resolutionTargetSeconds" type="number" min={1} required defaultValue={pool.resolutionTargetSeconds} /></label>{slaError && <p className="form-error" role="alert">{slaError}</p>}<div className="drawer-actions"><button type="button" onClick={() => setSlaPoolId(null)}>Cancel</button><button className="primary" type="submit">Save SLA</button></div></form> : <button type="button" onClick={() => { setSlaPoolId(pool.id); setSlaError(''); }}>Edit SLA</button>}</article>)}</div>) : <p className="empty-state">No service pools are configured for authorized events.</p>}</section>}
      </main>
    </div>
    </OperationalClock>
  );
}
