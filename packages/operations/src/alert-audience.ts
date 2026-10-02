const TERMINAL = new Set(['CLOSED', 'CANCELLED']);
const BROADCAST_TYPES = new Set(['TICKET_CREATED', 'TICKET_REOPENED', 'COMPLAINT_RAISED', 'TICKET_ESCALATED']);
const FIELD_SERVICES = new Set(['ELECTRICAL', 'HOUSE_HELP']);

export type AlertAudience = 'team' | 'assignment' | 'own' | 'manager' | 'stall';
export type AlertTone = 'assignment' | 'operational';
export type DeliveryLane = 'own-assignment' | 'hall-broadcast' | 'manager' | 'exhibitor' | 'none';

export function serviceCategoryLabel(category: string) {
  if (category === 'HOUSE_HELP') return 'House Help';
  if (category === 'ELECTRICAL') return 'Electrical';
  if (category === 'HALL_MANAGER') return 'Hall Manager';
  return 'Service';
}

export function isHallBroadcast(type: string) {
  return BROADCAST_TYPES.has(type);
}

export function teamBroadcastSummary(type: string, stallCode: string, category: string) {
  const place = `Stall ${stallCode}`;
  const service = serviceCategoryLabel(category);
  if (type === 'TICKET_REOPENED') return `Request opened again · ${place} · ${service}`;
  if (type === 'COMPLAINT_RAISED') return `Problem reported · ${place} · ${service}`;
  if (type === 'TICKET_ESCALATED') return `Escalated · ${place} · ${service}`;
  return `New request · ${place} · ${service}`;
}

export function exhibitorSummary(type: string) {
  if (type === 'TICKET_CREATED') return 'Your request was received.';
  if (type === 'TICKET_ASSIGNED') return 'Staff assigned.';
  if (type === 'TICKET_REOPENED') return 'Request reopened.';
  if (type === 'COMPLAINT_RAISED') return 'Problem reported.';
  if (type === 'TICKET_ESCALATED') return 'Manager reviewing your request.';
  if (type === 'TICKET_CLOSED' || type === 'TICKET_OVERRIDE_CLOSED') return 'Completed.';
  return 'Your request was updated.';
}

export function assignmentSummary(stallCode: string) {
  return `Your new task · Stall ${stallCode}`;
}

export function alertTone(type: string, audience: string): AlertTone {
  if (audience === 'assignment' || type === 'TICKET_ASSIGNED') return 'assignment';
  return 'operational';
}

export function alertHref(role: string, audience: string, notificationId: string, ticketId: string | null) {
  const ticketPath = ticketId && /^[A-Za-z0-9_-]{1,80}$/.test(ticketId) ? ticketId : null;
  const noticePath = /^[A-Za-z0-9_-]{1,80}$/.test(notificationId) ? notificationId : null;
  if (role === 'STALL' && ticketPath) return `/stall/ticket/${ticketPath}`;
  if (role === 'STAFF' && (audience === 'assignment' || audience === 'own') && ticketPath) return `/staff/task/${ticketPath}`;
  if (role === 'STAFF' && noticePath) return `/staff/alerts/${noticePath}`;
  if (role === 'HALL_MANAGER') return '/hall-manager';
  return '/';
}

export type DeliverySubject = {
  recipientId: string;
  role: string;
  status: string;
  approvalStatus: string;
  scopes: Array<{ eventId: string; hallId: string | null; stallId: string | null; serviceType: string | null }>;
  memberships: Array<{ availability: string; eventId: string; hallId: string | null; category: string; active: boolean }>;
};

export type DeliveryTicket = {
  eventId: string;
  hallId: string;
  stallId: string;
  category: string;
  status: string;
  stallActive: boolean;
  stallArchived: boolean;
  assigneeIds: string[];
};

export function decideAlertDelivery(input: {
  type: string;
  audience: string | null;
  eventId: string;
  subject: DeliverySubject;
  ticket: DeliveryTicket | null;
}): { lane: DeliveryLane; authorized: boolean; actionable: boolean; revokeSubscriptions: boolean } {
  const accountRevoked = input.subject.status !== 'ACTIVE' || input.subject.approvalStatus !== 'APPROVED';
  const lane = deliveryLane(input.subject.role, input.type, input.audience, input.subject.recipientId, input.ticket);
  if (accountRevoked) {
    return { lane, authorized: false, actionable: false, revokeSubscriptions: true };
  }
  const authorized = lane !== 'none' && laneAllows(lane, input);
  const open = Boolean(input.ticket && !TERMINAL.has(input.ticket.status));
  const repeating = open && (lane === 'own-assignment' || lane === 'hall-broadcast' || (lane === 'manager' && (isHallBroadcast(input.type) || input.type === 'TICKET_ASSIGNED')));
  return { lane, authorized, actionable: authorized && repeating, revokeSubscriptions: false };
}

function deliveryLane(role: string, type: string, audience: string | null, recipientId: string, ticket: DeliveryTicket | null): DeliveryLane {
  if (role === 'STALL') return 'exhibitor';
  if (role === 'HALL_MANAGER' || role === 'ADMIN' || role === 'SUPER_ADMIN') return 'manager';
  if (role !== 'STAFF') return 'none';
  const assigned = Boolean(ticket?.assigneeIds.includes(recipientId));
  if (audience === 'team') return 'hall-broadcast';
  if (audience === 'assignment' || audience === 'own' || type === 'TICKET_ASSIGNED') return 'own-assignment';
  if (isHallBroadcast(type) && !assigned) return 'hall-broadcast';
  if (assigned) return 'own-assignment';
  return 'none';
}

function laneAllows(lane: DeliveryLane, input: { eventId: string; subject: DeliverySubject; ticket: DeliveryTicket | null }) {
  const { subject, ticket, eventId } = input;
  if (!ticket) return subject.scopes.some((scope) => scope.eventId === eventId);
  if (ticket.eventId !== eventId) return false;
  if (lane === 'exhibitor') {
    return ticket.stallActive
      && !ticket.stallArchived
      && subject.scopes.some((scope) => scope.eventId === ticket.eventId && scope.stallId === ticket.stallId);
  }
  if (lane === 'manager') {
    if (subject.role === 'ADMIN' || subject.role === 'SUPER_ADMIN') {
      return subject.scopes.some((scope) => scope.eventId === ticket.eventId);
    }
    return subject.scopes.some((scope) => scope.eventId === ticket.eventId && scope.hallId === ticket.hallId);
  }
  if (lane === 'own-assignment') {
    return ticket.assigneeIds.includes(subject.recipientId) && staffScopeMatches(subject, ticket, true);
  }
  if (lane === 'hall-broadcast') {
    const onDuty = subject.memberships.some((membership) =>
      membership.availability === 'ON_DUTY'
      && membership.active
      && membership.eventId === ticket.eventId
      && membership.hallId === ticket.hallId
      && FIELD_SERVICES.has(membership.category));
    return onDuty && staffScopeMatches(subject, ticket, false);
  }
  return false;
}

function staffScopeMatches(subject: DeliverySubject, ticket: DeliveryTicket, matchService: boolean) {
  return subject.scopes.some((scope) =>
    scope.eventId === ticket.eventId
    && scope.hallId === ticket.hallId
    && (!matchService || scope.serviceType === ticket.category)
    && (matchService || (scope.serviceType != null && FIELD_SERVICES.has(scope.serviceType))));
}
