import { publishedBuildIdentity } from '@eveops/contracts';
import { presentActivity, presentNotification, projectTicketForRole, publicProgressLabel } from '@eveops/operations';

const ticket = {
  id: 't1',
  publicNo: 'EV-00001',
  category: 'ELECTRICAL',
  subtype: 'NCP',
  status: 'SNOOZED',
  description: 'Lights out',
  servicePriority: 'HIGH',
  slaState: 'RESPONSE_OVERDUE',
  pool: { responseTargetSeconds: 60, resolutionTargetSeconds: 3600 },
  queueState: 'ASSIGNED',
  assignments: [{ staff: { id: 's1', name: 'Ada', employeeCode: 'STF-1' } }],
  escalationLevel: 1,
  snoozedUntil: '2026-10-01T12:10:00.000Z',
  hall: { code: 'H1', name: 'Hall 1' },
  zone: { code: 'Z1' },
  stall: { stallCode: 'A1' },
  createdAt: '2026-10-01T12:00:00.000Z',
  capabilities: { verifyStallOtp: false, advanceHallManagerWork: false, emergencyClose: false },
  nextAction: 'ASSIGNEE_ACTION',
};

describe('ticket audience projection', () => {
  it('shows exhibitors progress without snooze or management fields', () => {
    const projected = projectTicketForRole(ticket, 'STALL');
    expect(publicProgressLabel('SNOOZED')).toBe('Staff assigned');
    expect(projected).toMatchObject({ status: 'ASSIGNED', progressLabel: 'Staff assigned', publicNo: 'EV-00001' });
    expect(projected).not.toHaveProperty('slaState');
    expect(projected).not.toHaveProperty('servicePriority');
    expect(projected).not.toHaveProperty('pool');
    expect(projected).not.toHaveProperty('assignments');
    expect(projected).not.toHaveProperty('snoozedUntil');
    expect(projected).not.toHaveProperty('escalationLevel');
  });

  it('keeps a worker task actionable without age or SLA fields', () => {
    const projected = projectTicketForRole({ ...ticket, status: 'ASSIGNED' }, 'STAFF');
    expect(projected).toMatchObject({ status: 'ASSIGNED', taskLabel: 'New task' });
    expect(projected).not.toHaveProperty('slaState');
    expect(projected).not.toHaveProperty('pool');
    expect(projected).not.toHaveProperty('progressLabel');
  });

  it('leaves manager records intact', () => {
    expect(projectTicketForRole(ticket, 'HALL_MANAGER')).toBe(ticket);
  });

  it('drops internal activity and notification fields for a stall', () => {
    expect(presentActivity({
      id: 'e1',
      eventType: 'ASSIGNMENT_SNOOZED',
      createdAt: '2026-10-01T12:00:00.000Z',
      actorName: 'Ada',
    }, 'STALL')).toBeNull();
    expect(presentActivity({
      id: 'e2',
      eventType: 'STATUS_ESCALATED',
      createdAt: '2026-10-01T12:00:00.000Z',
      actorName: 'Manager',
    }, 'STALL')).toEqual({
      id: 'e2',
      createdAt: '2026-10-01T12:00:00.000Z',
      summary: 'Manager reviewing your request.',
    });
    expect(presentNotification({
      id: 'n1',
      ticketId: 't1',
      type: 'TICKET_CREATED',
      sentAt: '2026-10-01T12:00:00.000Z',
      readAt: null,
      payload: { hallId: 'h1', stallId: 's1', summary: 'New request', publicNo: 'EV-00001', stallCode: 'A1' },
    }, 'STALL')).toEqual({
      id: 'n1',
      ticketId: 't1',
      type: 'TICKET_CREATED',
      sentAt: '2026-10-01T12:00:00.000Z',
      readAt: null,
      payload: { summary: 'New request', publicNo: 'EV-00001', stallCode: 'A1' },
    });
  });
});

describe('published build identity', () => {
  it('does not call an unlabeled production process development', () => {
    expect(publishedBuildIdentity({ NODE_ENV: 'production' })).toBe('unlabeled');
    expect(publishedBuildIdentity({ NODE_ENV: 'production', BUILD_SHA: 'development' })).toBe('unlabeled');
    expect(publishedBuildIdentity({ NODE_ENV: 'production', BUILD_SHA: 'development', RENDER_GIT_COMMIT: 'abc123' })).toBe('abc123');
    expect(publishedBuildIdentity({ NODE_ENV: 'production', BUILD_SHA: 'def456' })).toBe('def456');
    expect(publishedBuildIdentity({ NODE_ENV: 'development' })).toBe('development');
  });
});
