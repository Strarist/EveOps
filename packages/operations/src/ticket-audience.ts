const OPERATIONAL_ROLES = new Set(['HALL_MANAGER', 'ADMIN', 'SUPER_ADMIN']);

const STALL_HIDDEN_ACTIVITY = new Set([
  'ASSIGNMENT_SNOOZED',
  'QUEUE_PRIORITY_OVERRIDDEN',
  'SERVICE_PRIORITY_CHANGED',
  'SLA_BREACHED',
  'ASSIGNMENT_RESPONSE_OVERDUE',
  'STAFF_PINGED',
]);

const STAFF_HIDDEN_ACTIVITY = new Set([
  'QUEUE_PRIORITY_OVERRIDDEN',
  'SERVICE_PRIORITY_CHANGED',
  'SLA_BREACHED',
  'ASSIGNMENT_RESPONSE_OVERDUE',
]);

export function isOperationalRole(role: string) {
  return OPERATIONAL_ROLES.has(role);
}

export function publicProgressLabel(status: string) {
  switch (status) {
    case 'NEW':
      return 'Request received';
    case 'QUEUED':
      return 'Waiting for assistance';
    case 'ASSIGNED':
    case 'SNOOZED':
      return 'Staff assigned';
    case 'ACCEPTED':
      return 'Request accepted';
    case 'IN_PROGRESS':
      return 'Work in progress';
    case 'AWAITING_OTP':
      return 'Check the work and share your completion code';
    case 'CLOSED':
      return 'Completed';
    case 'COMPLAINT_RAISED':
      return 'Problem reported';
    case 'REOPENED':
      return 'Request reopened';
    case 'ESCALATED':
      return 'Manager reviewing your request';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return 'Update';
  }
}

export function staffTaskLabel(status: string) {
  switch (status) {
    case 'ASSIGNED':
      return 'New task';
    case 'SNOOZED':
      return 'Respond in 10 min';
    case 'ACCEPTED':
      return 'Accepted — go to stall';
    case 'IN_PROGRESS':
      return 'Work in progress';
    case 'AWAITING_OTP':
      return "Waiting for stall's code";
    case 'CLOSED':
      return 'Completed';
    case 'REOPENED':
      return 'Task opened again';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return 'Update';
  }
}

type TicketRecord = Record<string, unknown> & {
  status?: string;
  hall?: { code?: string; name?: string | null } | null;
  zone?: { code?: string } | null;
  stall?: { stallCode?: string } | null;
  event?: { id?: string; name?: string; timezone?: string } | null;
  capabilities?: {
    verifyStallOtp?: boolean;
    advanceHallManagerWork?: boolean;
    emergencyClose?: boolean;
  } | null;
  complaints?: Array<Record<string, unknown>>;
};

function location(ticket: TicketRecord) {
  return {
    hall: ticket.hall ? { code: ticket.hall.code, name: ticket.hall.name ?? undefined } : { code: '' },
    zone: ticket.zone ? { code: ticket.zone.code } : undefined,
    stall: { stallCode: ticket.stall?.stallCode ?? '' },
  };
}

function customerMilestones(ticket: TicketRecord) {
  return {
    createdAt: ticket.createdAt ?? null,
    closedAt: ticket.closedAt ?? null,
    cancelledAt: ticket.cancelledAt ?? null,
    complaintRaisedAt: ticket.complaintRaisedAt ?? null,
    reopenCount: ticket.reopenCount ?? 0,
    completionRequestedAt: ticket.completionRequestedAt ?? null,
    firstStartedAt: ticket.status === 'AWAITING_OTP' ? ticket.firstStartedAt ?? null : null,
  };
}

/** Allow-listed ticket payload. Operational roles keep the canonical record. */
export function projectTicketForRole<T extends TicketRecord>(ticket: T, role: string): T {
  if (isOperationalRole(role)) return ticket;
  const canonicalStatus = String(ticket.status ?? '');
  const status = role === 'STALL' && canonicalStatus === 'SNOOZED' ? 'ASSIGNED' : canonicalStatus;
  const projected: Record<string, unknown> = {
    id: ticket.id,
    publicNo: ticket.publicNo,
    eventId: ticket.eventId,
    hallId: ticket.hallId,
    zoneId: ticket.zoneId,
    stallId: ticket.stallId,
    priority: ticket.priority,
    category: ticket.category,
    subtype: ticket.subtype,
    status,
    description: ticket.description,
    ...location(ticket),
    ...customerMilestones(ticket),
    nextAction: ticket.nextAction ?? null,
    capabilities: {
      verifyStallOtp: role === 'STAFF' ? Boolean(ticket.capabilities?.verifyStallOtp) : false,
      advanceHallManagerWork: false,
      emergencyClose: false,
    },
  };
  if (ticket.event?.timezone || ticket.event?.name) {
    projected.event = {
      id: ticket.event.id,
      name: ticket.event.name,
      timezone: ticket.event.timezone,
    };
  }
  if (role === 'STALL') {
    projected.progressLabel = publicProgressLabel(canonicalStatus);
    if (Array.isArray(ticket.complaints)) {
      projected.complaints = ticket.complaints.map((complaint) => ({
        id: complaint.id,
        createdAt: complaint.createdAt,
        comment: complaint.comment ?? null,
      }));
    }
  }
  if (role === 'STAFF') projected.taskLabel = staffTaskLabel(canonicalStatus);
  return projected as T;
}

const ACTIVITY_SUMMARY: Record<string, { stall: string; staff: string }> = {
  TICKET_CREATED: { stall: 'Your request was received.', staff: 'This request was raised.' },
  TICKET_QUEUED: { stall: 'Waiting for assistance.', staff: 'This request is waiting for a free person.' },
  ASSIGNMENT_CREATED: { stall: 'Staff assigned.', staff: 'This task was assigned.' },
  TICKET_ASSIGNED: { stall: 'Staff assigned.', staff: 'This task was assigned.' },
  ASSIGNMENT_REASSIGNED: { stall: 'Staff assigned.', staff: 'This task was given to another person.' },
  STATUS_ACCEPTED: { stall: 'Request accepted.', staff: 'The task was accepted.' },
  STATUS_IN_PROGRESS: { stall: 'Work in progress.', staff: 'Work started.' },
  STATUS_AWAITING_OTP: { stall: 'Check the work and share your completion code.', staff: 'The stall was asked for the completion code.' },
  OTP_GENERATED: { stall: 'Check the work and share your completion code.', staff: 'The completion code is with the stall.' },
  OTP_REGENERATED: { stall: 'A new completion code is ready.', staff: 'A new completion code was prepared.' },
  OTP_VERIFY_FAILED: { stall: 'The completion code did not match.', staff: 'The completion code did not match.' },
  OTP_VERIFIED: { stall: 'Completed.', staff: 'The completion code was accepted.' },
  TICKET_CLOSED: { stall: 'Completed.', staff: 'This task was completed.' },
  COMPLAINT_RAISED: { stall: 'Problem reported.', staff: 'The stall reported a problem.' },
  STATUS_REOPENED: { stall: 'Request reopened.', staff: 'This task was opened again.' },
  TICKET_REOPENED: { stall: 'Request reopened.', staff: 'This task was opened again.' },
  ASSIGNMENT_SNOOZED: { stall: 'Staff assigned.', staff: 'You will respond in 10 minutes. The task stays yours.' },
  STATUS_ESCALATED: { stall: 'Manager reviewing your request.', staff: 'A manager is reviewing this task.' },
  STATUS_CANCELLED: { stall: 'Cancelled.', staff: 'This task was cancelled.' },
  OVERRIDE_CLOSED: { stall: 'Completed.', staff: 'This task was closed.' },
};

export function presentActivity(
  event: { id: string; eventType: string; createdAt: Date | string; actorName?: string | null },
  role: string,
) {
  if (isOperationalRole(role)) {
    return {
      id: event.id,
      eventType: event.eventType,
      createdAt: event.createdAt,
      actorName: event.actorName ?? 'System',
    };
  }
  const hidden = role === 'STALL' ? STALL_HIDDEN_ACTIVITY : STAFF_HIDDEN_ACTIVITY;
  if (hidden.has(event.eventType)) return null;
  const copy = ACTIVITY_SUMMARY[event.eventType];
  const summary = role === 'STALL'
    ? (copy?.stall ?? 'Your request was updated.')
    : (copy?.staff ?? 'This task was updated.');
  return { id: event.id, createdAt: event.createdAt, summary };
}

export function presentNotification(
  notification: { id: string; ticketId: string | null; type: string; sentAt: Date | string; readAt: Date | string | null; payload: unknown },
  role: string,
  live?: { status?: string | null; assigneeIds?: string[]; viewerId?: string },
) {
  if (isOperationalRole(role)) {
    const payload = notification.payload && typeof notification.payload === 'object' && !Array.isArray(notification.payload)
      ? { ...(notification.payload as Record<string, unknown>) }
      : null;
    const terminal = live?.status === 'CLOSED' || live?.status === 'CANCELLED';
    if (payload && terminal) payload.actionable = false;
    const rest = Object.fromEntries(
      Object.entries(notification as Record<string, unknown>).filter(([key]) => key !== 'ticket'),
    ) as typeof notification;
    return payload ? { ...rest, payload } : rest;
  }
  const payload = notification.payload && typeof notification.payload === 'object' && !Array.isArray(notification.payload)
    ? notification.payload as Record<string, unknown>
    : {};
  const summary = typeof payload.summary === 'string' && payload.summary.trim()
    ? payload.summary.trim()
    : 'Update';
  const audience = typeof payload.audience === 'string' ? payload.audience : '';
  const terminal = live?.status === 'CLOSED' || live?.status === 'CANCELLED';
  const viewerId = live?.viewerId ?? '';
  const lostAssignment = (audience === 'assignment' || audience === 'own')
    && viewerId.length > 0
    && Array.isArray(live?.assigneeIds)
    && !live.assigneeIds.includes(viewerId);
  const summaryOnly = role === 'STAFF' && (audience === 'team' || lostAssignment);
  const presented: Record<string, unknown> = {
    summary,
    ...(typeof payload.publicNo === 'string' ? { publicNo: payload.publicNo } : {}),
    ...(typeof payload.stallCode === 'string' ? { stallCode: payload.stallCode } : {}),
  };
  if (audience) {
    presented.audience = summaryOnly ? 'team' : audience;
    presented.tone = payload.tone === 'assignment' && !summaryOnly ? 'assignment' : 'operational';
    presented.actionable = payload.actionable === true && !terminal && !lostAssignment;
    presented.href = summaryOnly
      ? `/staff/alerts/${notification.id}`
      : role === 'STAFF'
        ? `/staff/task/${notification.ticketId}`
        : `/stall/ticket/${notification.ticketId}`;
  }
  return {
    id: notification.id,
    ticketId: summaryOnly ? null : notification.ticketId,
    type: notification.type,
    sentAt: notification.sentAt,
    readAt: notification.readAt,
    payload: presented,
  };
}
