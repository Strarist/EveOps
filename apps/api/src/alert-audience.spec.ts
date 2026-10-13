import { decideAlertDelivery, presentNotification, teamBroadcastSummary } from '@eveops/operations';
import { claimTabPlayback, cuesToRing, enqueueCues, planAlertSetup } from '@eveops/operations';

const subject = {
  recipientId: 'staff-1',
  role: 'STAFF',
  status: 'ACTIVE',
  approvalStatus: 'APPROVED',
  scopes: [{ eventId: 'event-1', hallId: 'hall-1', stallId: null, serviceType: 'ELECTRICAL' }],
  memberships: [{ availability: 'ON_DUTY', eventId: 'event-1', hallId: 'hall-1', category: 'ELECTRICAL', active: true }],
};

const ticket = {
  eventId: 'event-1',
  hallId: 'hall-1',
  stallId: 'stall-1',
  category: 'HOUSE_HELP',
  status: 'ASSIGNED',
  stallActive: true,
  stallArchived: false,
  assigneeIds: ['other-staff'],
};

describe('alert delivery lanes', () => {
  it('lets on-duty hall staff receive a team broadcast without owning the ticket', () => {
    const decision = decideAlertDelivery({
      type: 'TICKET_CREATED',
      audience: 'team',
      eventId: 'event-1',
      subject,
      ticket,
    });
    expect(decision).toMatchObject({ lane: 'hall-broadcast', authorized: true, actionable: true, revokeSubscriptions: false });
    expect(teamBroadcastSummary('TICKET_CREATED', 'B203', 'HOUSE_HELP')).toBe('New request · Stall B203 · House Help');
  });

  it('drops a team broadcast when the worker is off duty or outside the hall', () => {
    const offDuty = decideAlertDelivery({
      type: 'TICKET_CREATED',
      audience: 'team',
      eventId: 'event-1',
      subject: { ...subject, memberships: [{ ...subject.memberships[0], availability: 'OFF_DUTY' }] },
      ticket,
    });
    const otherHall = decideAlertDelivery({
      type: 'TICKET_CREATED',
      audience: 'team',
      eventId: 'event-1',
      subject: { ...subject, scopes: [{ ...subject.scopes[0], hallId: 'hall-2' }], memberships: [{ ...subject.memberships[0], hallId: 'hall-2' }] },
      ticket,
    });
    expect(offDuty.authorized).toBe(false);
    expect(otherHall.authorized).toBe(false);
  });

  it('keeps a paused assignee on their own task and refuses another worker', () => {
    const paused = decideAlertDelivery({
      type: 'COMPLAINT_RAISED',
      audience: 'own',
      eventId: 'event-1',
      subject: {
        ...subject,
        recipientId: 'paused-1',
        scopes: [{ eventId: 'event-1', hallId: 'hall-1', stallId: null, serviceType: 'HOUSE_HELP' }],
        memberships: [{ availability: 'PAUSED', eventId: 'event-1', hallId: 'hall-1', category: 'HOUSE_HELP', active: true }],
      },
      ticket: { ...ticket, assigneeIds: ['paused-1'], category: 'HOUSE_HELP' },
    });
    const stranger = decideAlertDelivery({
      type: 'TICKET_ASSIGNED',
      audience: 'assignment',
      eventId: 'event-1',
      subject,
      ticket,
    });
    expect(paused).toMatchObject({ lane: 'own-assignment', authorized: true });
    expect(stranger.authorized).toBe(false);
  });

  it('stops repeating after closure without revoking a still-valid exhibitor', () => {
    const closed = decideAlertDelivery({
      type: 'TICKET_CREATED',
      audience: 'stall',
      eventId: 'event-1',
      subject: {
        recipientId: 'stall-1',
        role: 'STALL',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        scopes: [{ eventId: 'event-1', hallId: 'hall-1', stallId: 'stall-1', serviceType: null }],
        memberships: [],
      },
      ticket: { ...ticket, status: 'CLOSED' },
    });
    expect(closed).toMatchObject({ lane: 'exhibitor', authorized: true, actionable: false });
  });

  it('hides the ticket link and operational fields from an unassigned staff alert', () => {
    const presented = presentNotification({
      id: 'n1',
      ticketId: 't1',
      type: 'TICKET_CREATED',
      sentAt: '2026-10-02T12:00:00.000Z',
      readAt: null,
      payload: {
        audience: 'team',
        tone: 'operational',
        actionable: true,
        summary: 'New request · Stall B203 · House Help',
        stallCode: 'B203',
        hallId: 'hall-1',
        priority: 'URGENT',
        servicePriority: 'HIGH',
      },
    }, 'STAFF', { status: 'ASSIGNED', assigneeIds: ['other'], viewerId: 'staff-1' });
    expect(presented).toMatchObject({
      ticketId: null,
      payload: {
        summary: 'New request · Stall B203 · House Help',
        audience: 'team',
        href: '/staff/alerts/n1',
        actionable: true,
      },
    });
    expect(presented.payload).not.toHaveProperty('hallId');
    expect(presented.payload).not.toHaveProperty('priority');
    expect(presented.payload).not.toHaveProperty('servicePriority');
  });
});

describe('alert session', () => {
  it('queues distinct events, ignores a duplicate, and rings a later event for the same ticket', () => {
    expect(enqueueCues(['a'], 'b', ['a', 'c'])).toEqual(['a', 'c']);
    const first = cuesToRing({
      incoming: [{ id: 'old', sentAt: '2026-10-02T12:00:00.000Z', actionable: true, tone: 'operational' }],
      cursor: null,
      acknowledged: [],
      played: [],
      now: '2026-10-02T12:05:00.000Z',
    });
    expect(first.ring).toEqual([]);
    const missed = cuesToRing({
      incoming: [
        { id: 'old', sentAt: '2026-10-02T12:00:00.000Z', actionable: true, tone: 'operational' },
        { id: 'reopened', sentAt: '2026-10-02T12:06:00.000Z', actionable: true, tone: 'operational' },
      ],
      cursor: first.nextCursor,
      acknowledged: ['old'],
      played: [],
      now: '2026-10-02T12:07:00.000Z',
    });
    expect(missed.ring.map((cue) => cue.id)).toEqual(['reopened']);
  });

  it('does not ring a closed alert and lets a free tab take playback', () => {
    const closed = cuesToRing({
      incoming: [{ id: 'done', sentAt: '2026-10-02T12:08:00.000Z', actionable: false, tone: 'assignment' }],
      cursor: '2026-10-02T12:00:00.000Z',
      acknowledged: [],
      played: [],
      now: '2026-10-02T12:09:00.000Z',
    });
    expect(closed.ring).toEqual([]);
    expect(claimTabPlayback({ tabId: 'tab-b', claim: { tabId: 'tab-a', until: 100 }, now: 50 })).toBe(false);
    expect(claimTabPlayback({ tabId: 'tab-b', claim: { tabId: 'tab-a', until: 100 }, now: 100 })).toBe(true);
  });

  it('asks for notification permission once and keeps a denied browser recoverable', () => {
    expect(planAlertSetup({
      notification: 'granted',
      audio: 'running',
      pushConfigured: true,
      alreadyAsked: false,
      subscription: 'registered',
    }).requestPermission).toBe(false);
    const denied = planAlertSetup({
      notification: 'denied',
      audio: 'running',
      pushConfigured: true,
      alreadyAsked: true,
      subscription: 'skipped',
    });
    expect(denied.requestPermission).toBe(false);
    expect(denied.recovery).toMatch(/on this screen/);
    const dismissed = planAlertSetup({
      notification: 'default',
      audio: 'running',
      pushConfigured: true,
      alreadyAsked: true,
      subscription: 'skipped',
    });
    expect(dismissed.requestPermission).toBe(false);
    expect(dismissed.recovery).toMatch(/not allowed/);
    const closedManager = presentNotification({
      id: 'notice-closed',
      ticketId: 'ticket-1',
      type: 'TICKET_CREATED',
      sentAt: '2026-10-02T12:00:00.000Z',
      readAt: null,
      payload: { audience: 'manager', actionable: true, summary: 'New request · Stall B203 · House Help', hallId: 'hall-1' },
    }, 'HALL_MANAGER', { status: 'CLOSED', assigneeIds: [], viewerId: 'manager-1' });
    expect(closedManager.payload).toMatchObject({ actionable: false, hallId: 'hall-1' });
    expect(planAlertSetup({
      notification: 'unsupported',
      audio: 'unsupported',
      pushConfigured: false,
      alreadyAsked: false,
      subscription: 'skipped',
    }).requestPermission).toBe(false);
  });
});
