import { ForbiddenException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { assertPortalRole, assertScope, assertTransition, requireAuthority } from './domain';
import { canReceiveEvent, type DomainEvent } from './realtime';

describe('ticket domain invariants', () => {
  it('permits documented transitions', () => expect(() => assertTransition('IN_PROGRESS', 'AWAITING_OTP')).not.toThrow());
  it('rejects illegal transitions', () => expect(() => assertTransition('NEW', 'CLOSED')).toThrow(UnprocessableEntityException));
  it('keeps cancelled terminal', () => expect(() => assertTransition('CANCELLED', 'NEW')).toThrow(UnprocessableEntityException));
  it('enforces stall scope', () => expect(() => assertScope({ userId: 'u', role: 'STALL', eventIds: ['e'], hallIds: [], stallId: 's1', serviceTypes: [] }, { eventId: 'e', stallId: 's2' })).toThrow(ForbiddenException));
  it('enforces manager authority', () => expect(() => requireAuthority('STAFF', 'HALL_MANAGER')).toThrow(ForbiddenException));
  it('blocks Admin credentials from governance', () => expect(() => assertPortalRole('ADMIN', 'GOVERNANCE')).toThrow(UnauthorizedException));
  it('blocks SuperAdmin credentials from operational login', () => expect(() => assertPortalRole('SUPER_ADMIN', 'OPERATIONS')).toThrow(UnauthorizedException));
  it('allows SuperAdmin only through governance login', () => expect(() => assertPortalRole('SUPER_ADMIN', 'GOVERNANCE')).not.toThrow());
  it('does not disclose another stall ticket over realtime', () => {
    const event: DomainEvent = { eventId: 'e', hallId: 'h', stallId: 's2', type: 'ticket.updated', data: {} };
    expect(canReceiveEvent({ userId: 'u', role: 'STALL', eventIds: ['e'], hallIds: ['h'], stallId: 's1', serviceTypes: [] }, event)).toBe(false);
  });
  it('does not disclose an unassigned ticket to staff over realtime', () => {
    const event: DomainEvent = { eventId: 'e', hallId: 'h', stallId: 's1', assigneeId: 'other', type: 'ticket.updated', data: {} };
    expect(canReceiveEvent({ userId: 'staff', role: 'STAFF', eventIds: ['e'], hallIds: ['h'], serviceTypes: ['ELECTRICAL'] }, event)).toBe(false);
  });
  it('reconciles a ticket removed from a previous assignee', () => {
    const event: DomainEvent = { eventId: 'e', hallId: 'h', stallId: 's1', assigneeId: 'new-staff', assigneeIds: ['old-staff', 'new-staff'], type: 'ticket.updated', data: {} };
    expect(canReceiveEvent({ userId: 'old-staff', role: 'STAFF', eventIds: ['e'], hallIds: ['h'], serviceTypes: ['ELECTRICAL'] }, event)).toBe(true);
  });
  it('restricts Hall Manager realtime to assigned halls', () => {
    const event: DomainEvent = { eventId: 'e', hallId: 'h2', stallId: 's1', type: 'ticket.updated', data: {} };
    expect(canReceiveEvent({ userId: 'manager', role: 'HALL_MANAGER', eventIds: ['e'], hallIds: ['h1'], serviceTypes: [] }, event)).toBe(false);
  });
});
