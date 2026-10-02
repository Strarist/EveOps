/** Display timing derived from stored lifecycle timestamps and a server clock. */

export const FUTURE_TOLERANCE_MS = 120_000;

export type TimingInstant = string | Date | null | undefined;

export type TicketTimingInput = {
  status: string;
  createdAt?: TimingInstant;
  closedAt?: TimingInstant;
  reopenCount?: number | null;
  complaintRaisedAt?: TimingInstant;
  currentCycleStartedAt?: TimingInstant;
  cancelledAt?: TimingInstant;
  completionRequestedAt?: TimingInstant;
};

export type TimingFact = { label: string; value: string };

export type TicketTimingDisplay = {
  facts: TimingFact[];
  fixed: boolean;
};

const UNAVAILABLE = 'Unavailable';
const PENDING = 'Pending';

export function parseTimingInstant(value: TimingInstant): number | null {
  if (value == null || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function formatElapsedSeconds(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes).padStart(2, '0')}m`;
}

function elapsedLabel(start: TimingInstant, nowMs: number | null): string {
  const startMs = parseTimingInstant(start);
  if (startMs == null) return UNAVAILABLE;
  if (nowMs == null) return PENDING;
  if (startMs > nowMs + FUTURE_TOLERANCE_MS) return UNAVAILABLE;
  return formatElapsedSeconds(Math.floor((nowMs - startMs) / 1000)) ?? UNAVAILABLE;
}

function fixedInterval(start: TimingInstant, end: TimingInstant): string {
  const startMs = parseTimingInstant(start);
  const endMs = parseTimingInstant(end);
  if (startMs == null || endMs == null) return UNAVAILABLE;
  if (endMs < startMs) return UNAVAILABLE;
  return formatElapsedSeconds(Math.floor((endMs - startMs) / 1000)) ?? UNAVAILABLE;
}

export function describeTicketTiming(input: TicketTimingInput, serverNowMs: number | null): TicketTimingDisplay {
  const status = input.status;
  if (status === 'CLOSED') {
    return {
      facts: [{ label: 'Resolved in', value: fixedInterval(input.createdAt, input.closedAt) }],
      fixed: true,
    };
  }
  if (status === 'CANCELLED') {
    return {
      facts: [{ label: 'Cancelled', value: fixedInterval(input.createdAt, input.cancelledAt) }],
      fixed: true,
    };
  }

  const opened: TimingFact = { label: input.reopenCount ? 'Opened' : 'Age', value: elapsedLabel(input.createdAt, serverNowMs) };
  const facts: TimingFact[] = [opened];
  const reopened = status === 'REOPENED' || (input.reopenCount ?? 0) > 0;

  if (status === 'COMPLAINT_RAISED') {
    facts[0] = { label: 'Opened', value: elapsedLabel(input.createdAt, serverNowMs) };
    facts.push({ label: 'Issue reported', value: elapsedLabel(input.complaintRaisedAt, serverNowMs) });
    return { facts, fixed: false };
  }

  if (reopened) {
    facts[0] = { label: 'Opened', value: elapsedLabel(input.createdAt, serverNowMs) };
    facts.push({ label: 'This cycle', value: elapsedLabel(input.currentCycleStartedAt, serverNowMs) });
  }

  if (status === 'AWAITING_OTP') {
    const waited = elapsedLabel(input.completionRequestedAt, serverNowMs);
    facts.push({ label: 'Awaiting verification', value: input.completionRequestedAt ? waited : PENDING });
  }

  return { facts, fixed: false };
}

/** Newest-first lifecycle events from the ticket timeline. */
export function lifecycleTiming(events: Array<{ eventType: string; createdAt: Date }>) {
  const latest = (eventType: string) => events.reduce<Date | null>((found, event) => {
    if (event.eventType !== eventType) return found;
    const at = new Date(event.createdAt);
    return !found || at.getTime() > found.getTime() ? at : found;
  }, null);
  return {
    complaintRaisedAt: latest('COMPLAINT_RAISED'),
    currentCycleStartedAt: latest('STATUS_REOPENED'),
    cancelledAt: latest('STATUS_CANCELLED'),
  };
}

/** Reasoned override, then HIGH → MEDIUM → LOW, then creation time, then id. Incident urgency is not part of this order. */
export const serviceQueueOrderBy = [
  { queuePriorityOverrideAt: { sort: 'asc' as const, nulls: 'last' as const } },
  { servicePriority: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

const activeListOrder = [
  { priority: 'desc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

/**
 * Queued view follows service-queue precedence.
 * Attention uses the same order as the active list: urgent, then oldest, then id.
 * `recent` is newest created first and is not a scheduling rank.
 */
export function ticketListOrder(view?: string, sort?: string) {
  if (view === 'queued') return serviceQueueOrderBy;
  if (sort === 'recent') {
    return [
      { createdAt: 'desc' as const },
      { id: 'desc' as const },
    ];
  }
  if (view === 'closed') {
    return [
      { closedAt: { sort: 'desc' as const, nulls: 'last' as const } },
      { id: 'desc' as const },
    ];
  }
  return activeListOrder;
}

export type ManagerAttentionInput = {
  status: string;
  slaState?: string | null;
  priority?: boolean | string | null;
  reopenCount?: number | null;
};

/**
 * Hall Manager attention, matching the operational list:
 * complained, escalated, past the resolution target, response overdue,
 * urgent, opened again, newly raised, waiting for a completion code,
 * or assigned and not yet started.
 * Ordinary queued, accepted, and in-progress work is not included.
 * Closed and cancelled work is not included.
 */
export function managerAttentionLabel(ticket: ManagerAttentionInput): string | null {
  if (ticket.status === 'CLOSED' || ticket.status === 'CANCELLED') return null;
  if (ticket.status === 'COMPLAINT_RAISED') return 'The stall reported a problem';
  if (ticket.status === 'ESCALATED') return 'Escalated and waiting for a decision';
  if (ticket.slaState === 'SLA breached' || ticket.slaState === 'SLA_BREACHED') return 'Past the resolution target';
  if (ticket.slaState === 'Response overdue' || ticket.slaState === 'RESPONSE_OVERDUE') return 'Waiting too long for a response';
  if (ticket.priority === true || ticket.priority === 'URGENT') return 'Marked urgent';
  if (ticket.status === 'REOPENED' || ((ticket.reopenCount ?? 0) > 0 && ['NEW', 'QUEUED', 'ASSIGNED', 'SNOOZED'].includes(ticket.status))) {
    return 'Opened again';
  }
  if (ticket.status === 'NEW') return 'Just raised';
  if (ticket.status === 'AWAITING_OTP') return 'Waiting for the stall to confirm completion';
  if (ticket.status === 'ASSIGNED' || ticket.status === 'SNOOZED') return 'Assigned and not yet started';
  return null;
}

export function displayLiveAgeSeconds(status: string, createdAt: Date, nowMs: number): number | null {
  if (status === 'CLOSED' || status === 'CANCELLED') return null;
  const seconds = Math.floor((nowMs - createdAt.getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds;
}

export function closedResolutionSeconds(status: string, createdAt: Date, closedAt: Date | null): number | null {
  if (status !== 'CLOSED' || !closedAt) return null;
  const seconds = Math.floor((closedAt.getTime() - createdAt.getTime()) / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

export function boundedElapsedSeconds(start: Date | null | undefined, nowMs: number): number | null {
  if (!start) return null;
  const seconds = Math.floor((nowMs - start.getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds;
}

export function serverClockOffset(serverTimeIso: string, receivedAtMs: number): number | null {
  const serverMs = Date.parse(serverTimeIso);
  if (!Number.isFinite(serverMs) || !Number.isFinite(receivedAtMs)) return null;
  return serverMs - receivedAtMs;
}

export function operationalNow(clientNowMs: number, offsetMs: number): number {
  return clientNowMs + offsetMs;
}

export function shouldRefreshForTicketEvent(
  seen: Map<string, number>,
  payload: { ticketId?: string; version?: number } | null,
): boolean {
  if (!payload?.ticketId || typeof payload.version !== 'number' || !Number.isFinite(payload.version)) return true;
  const previous = seen.get(payload.ticketId) ?? -1;
  if (payload.version <= previous) return false;
  seen.set(payload.ticketId, payload.version);
  return true;
}
