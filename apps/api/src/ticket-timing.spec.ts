import {
  closedResolutionSeconds,
  describeTicketTiming,
  displayLiveAgeSeconds,
  lifecycleTiming,
  operationalNow,
  serverClockOffset,
  serviceQueueOrderBy,
  shouldRefreshForTicketEvent,
  managerAttentionLabel,
  ticketListOrder,
} from '@eveops/operations';

const created = '2026-10-01T12:00:00.000Z';
const fiveMinutesLater = Date.parse('2026-10-01T12:05:00.000Z');
const tenDaysLater = Date.parse('2026-10-11T12:05:00.000Z');

describe('ticket timing display', () => {
  it('shows a fixed resolution interval after OTP closure, including days later', () => {
    const input = {
      status: 'CLOSED',
      createdAt: created,
      closedAt: '2026-10-01T12:05:00.000Z',
    };
    const closed = describeTicketTiming(input, fiveMinutesLater);
    const later = describeTicketTiming(input, tenDaysLater);
    expect(closed.facts).toEqual([{ label: 'Resolved in', value: '05m' }]);
    expect(later).toEqual(closed);
    expect(closed.fixed).toBe(true);
  });

  it('reproduces the deployed complaint card without calling a previous closure resolved', () => {
    const display = describeTicketTiming({
      status: 'COMPLAINT_RAISED',
      createdAt: '2026-09-21T17:31:59.020Z',
      closedAt: '2026-09-28T20:13:54.977Z',
      reopenCount: 1,
      complaintRaisedAt: '2026-10-01T12:28:16.823Z',
    }, Date.parse('2026-10-01T12:28:16.823Z'));
    expect(display.facts.map((fact) => fact.label)).toEqual(['Opened', 'Issue reported']);
    expect(display.facts[0]?.value).toBe('9d 18h');
    expect(display.facts[1]?.value).toBe('0s');
    expect(display.facts.some((fact) => fact.label === 'Resolved in')).toBe(false);
    const later = describeTicketTiming({
      status: 'CLOSED',
      createdAt: '2026-09-21T17:31:59.020Z',
      closedAt: '2026-10-01T12:58:10.519Z',
      reopenCount: 2,
    }, Date.parse('2026-10-08T12:58:10.519Z'));
    expect(later.facts).toEqual([{ label: 'Resolved in', value: '9d 19h' }]);
  });

  it('follows the server clock when the browser is ten days ahead or behind', () => {
    const serverTime = '2026-10-01T12:05:00.000Z';
    const ahead = Date.parse('2026-10-11T12:05:00.000Z');
    const behind = Date.parse('2026-09-21T12:05:00.000Z');
    const aheadOffset = serverClockOffset(serverTime, ahead);
    const behindOffset = serverClockOffset(serverTime, behind);
    expect(aheadOffset).not.toBeNull();
    expect(behindOffset).not.toBeNull();
    expect(operationalNow(ahead, aheadOffset ?? 0)).toBe(fiveMinutesLater);
    expect(operationalNow(behind, behindOffset ?? 0)).toBe(fiveMinutesLater);
    const display = describeTicketTiming({ status: 'ASSIGNED', createdAt: created }, fiveMinutesLater);
    expect(display.facts).toEqual([{ label: 'Age', value: '05m' }]);
  });

  it('keeps elapsed duration on epoch time so a timezone does not change it', () => {
    const display = describeTicketTiming({
      status: 'ASSIGNED',
      createdAt: '2026-10-01T00:00:00.000Z',
    }, Date.parse('2026-10-01T02:30:00.000Z'));
    expect(display.facts[0]).toEqual({ label: 'Age', value: '2h 30m' });
    expect(Date.parse('2026-10-01T02:30:00.000Z') - Date.parse('2026-10-01T00:00:00.000Z')).toBe(9_000_000);
  });

  it('distinguishes an old ticket reopened today and leaves queue order untouched', () => {
    const input = {
      status: 'ASSIGNED',
      createdAt: '2026-09-21T17:31:59.020Z',
      reopenCount: 2,
      currentCycleStartedAt: '2026-10-01T12:56:05.137Z',
    };
    const frozen = input.createdAt;
    const display = describeTicketTiming(input, Date.parse('2026-10-01T12:58:05.137Z'));
    expect(input.createdAt).toBe(frozen);
    expect(display.facts).toEqual([
      { label: 'Opened', value: '9d 19h' },
      { label: 'This cycle', value: '02m' },
    ]);
    expect(serviceQueueOrderBy).toEqual([
      { queuePriorityOverrideAt: { sort: 'asc', nulls: 'last' } },
      { servicePriority: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ]);
    expect(ticketListOrder('queued')).toEqual(serviceQueueOrderBy);
    expect(ticketListOrder('active').some((rule) => 'priority' in rule)).toBe(true);
    expect(ticketListOrder('active').some((rule) => 'servicePriority' in rule)).toBe(false);
    expect(ticketListOrder('closed')[0]).toEqual({ closedAt: { sort: 'desc', nulls: 'last' } });
    expect(ticketListOrder('attention')).toEqual(ticketListOrder('active'));
    expect(ticketListOrder('all', 'recent')[0]).toEqual({ createdAt: 'desc' });
    expect(ticketListOrder('queued', 'recent')).toEqual(serviceQueueOrderBy);
    expect(managerAttentionLabel({ status: 'COMPLAINT_RAISED' })).toBe('The stall reported a problem');
    expect(managerAttentionLabel({ status: 'QUEUED', priority: 'NORMAL', reopenCount: 0, slaState: 'ON_TRACK' })).toBeNull();
    expect(managerAttentionLabel({ status: 'IN_PROGRESS', priority: 'URGENT' })).toBe('Marked urgent');
    expect(managerAttentionLabel({ status: 'QUEUED', reopenCount: 1, slaState: 'ON_TRACK' })).toBe('Opened again');
    expect(managerAttentionLabel({ status: 'ACCEPTED', slaState: 'RESPONSE_OVERDUE' })).toBe('Waiting too long for a response');
    expect(managerAttentionLabel({ status: 'IN_PROGRESS', slaState: 'SLA_BREACHED' })).toBe('Past the resolution target');
    expect(managerAttentionLabel({ status: 'ASSIGNED' })).toBe('Assigned and not yet started');
    expect(managerAttentionLabel({ status: 'AWAITING_OTP' })).toBe('Waiting for the stall to confirm completion');
    expect(managerAttentionLabel({ status: 'CLOSED', priority: 'URGENT' })).toBeNull();
    expect(managerAttentionLabel({ status: 'SNOOZED' })).toBe('Assigned and not yet started');
  });

  it('does not treat work awaiting a code as resolved', () => {
    const display = describeTicketTiming({
      status: 'AWAITING_OTP',
      createdAt: created,
      completionRequestedAt: '2026-10-01T12:04:00.000Z',
      closedAt: null,
    }, fiveMinutesLater);
    expect(display.facts.map((fact) => fact.label)).toEqual(['Age', 'Awaiting verification']);
    expect(display.facts.some((fact) => /resolved/i.test(fact.label))).toBe(false);
  });

  it('uses cancellation wording and refuses a missing or future duration', () => {
    expect(describeTicketTiming({
      status: 'CANCELLED',
      createdAt: created,
      cancelledAt: '2026-10-01T13:00:00.000Z',
    }, fiveMinutesLater).facts).toEqual([{ label: 'Cancelled', value: '1h 00m' }]);
    expect(describeTicketTiming({
      status: 'CLOSED',
      createdAt: created,
      closedAt: null,
    }, fiveMinutesLater).facts[0]).toEqual({ label: 'Resolved in', value: 'Unavailable' });
    expect(describeTicketTiming({
      status: 'CLOSED',
      createdAt: created,
      closedAt: '2026-09-01T12:00:00.000Z',
    }, fiveMinutesLater).facts[0]?.value).toBe('Unavailable');
    expect(describeTicketTiming({
      status: 'ASSIGNED',
      createdAt: '2026-10-20T12:00:00.000Z',
    }, fiveMinutesLater).facts[0]?.value).toBe('Unavailable');
    expect(describeTicketTiming({ status: 'ASSIGNED', createdAt: 'not-a-time' }, fiveMinutesLater).facts[0]?.value).toBe('Unavailable');
    expect(describeTicketTiming({ status: 'ASSIGNED', createdAt: created }, null).facts[0]?.value).toBe('Pending');
  });

  it('reconciles a newer ticket version and still refreshes an unknown event', () => {
    const seen = new Map();
    expect(shouldRefreshForTicketEvent(seen, { ticketId: 't1', version: 2 })).toBe(true);
    expect(shouldRefreshForTicketEvent(seen, { ticketId: 't1', version: 2 })).toBe(false);
    expect(shouldRefreshForTicketEvent(seen, { ticketId: 't1', version: 3 })).toBe(true);
    expect(shouldRefreshForTicketEvent(seen, {})).toBe(true);
  });

  it('reads the latest complaint and reopen events without treating closure as live age', () => {
    const timing = lifecycleTiming([
      { eventType: 'STATUS_REOPENED', createdAt: new Date('2026-10-01T12:56:05.137Z') },
      { eventType: 'COMPLAINT_RAISED', createdAt: new Date('2026-10-01T12:28:16.823Z') },
      { eventType: 'COMPLAINT_RAISED', createdAt: new Date('2026-09-21T17:39:17.948Z') },
    ]);
    expect(timing.complaintRaisedAt?.toISOString()).toBe('2026-10-01T12:28:16.823Z');
    expect(timing.currentCycleStartedAt?.toISOString()).toBe('2026-10-01T12:56:05.137Z');
    const now = Date.parse('2026-10-08T00:00:00.000Z');
    const createdAt = new Date('2026-09-21T17:31:59.020Z');
    const closedAt = new Date('2026-10-01T12:58:10.519Z');
    expect(displayLiveAgeSeconds('CLOSED', createdAt, now)).toBeNull();
    expect(closedResolutionSeconds('COMPLAINT_RAISED', createdAt, closedAt)).toBeNull();
    expect(closedResolutionSeconds('CLOSED', createdAt, closedAt)).toBe(847571);
  });
});
