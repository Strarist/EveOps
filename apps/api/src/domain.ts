import { ForbiddenException, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthScope, Role, TicketStatus } from '@eveops/contracts';

export const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  NEW: ['ASSIGNED', 'QUEUED', 'CANCELLED'],
  ASSIGNED: ['ACCEPTED', 'SNOOZED'],
  SNOOZED: ['ACCEPTED', 'ESCALATED', 'ASSIGNED'],
  QUEUED: ['ASSIGNED', 'CANCELLED'],
  ACCEPTED: ['IN_PROGRESS', 'ASSIGNED'],
  IN_PROGRESS: ['AWAITING_OTP', 'ESCALATED'],
  AWAITING_OTP: ['CLOSED', 'COMPLAINT_RAISED', 'IN_PROGRESS'],
  CLOSED: ['REOPENED'],
  COMPLAINT_RAISED: ['REOPENED', 'ESCALATED'],
  REOPENED: ['ASSIGNED', 'QUEUED'],
  ESCALATED: ['ASSIGNED', 'REOPENED', 'CLOSED'],
  CANCELLED: [],
};

export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new UnprocessableEntityException('Invalid ticket transition: ' + from + ' -> ' + to);
  }
}

export function assertScope(scope: AuthScope, target: { eventId: string; hallId?: string; stallId?: string }): void {
  if (!scope.eventIds.includes(target.eventId)) throw new ForbiddenException('Event is outside your scope');
  if (scope.role === 'STALL' && scope.stallId !== target.stallId) throw new ForbiddenException('Stall is outside your scope');
  if (scope.role === 'HALL_MANAGER' && target.hallId && !scope.hallIds.includes(target.hallId)) {
    throw new ForbiddenException('Hall is outside your scope');
  }
}

const authority: Record<Role, number> = { STALL: 0, STAFF: 0, HALL_MANAGER: 1, ADMIN: 2, SUPER_ADMIN: 3 };
export function requireAuthority(role: Role, minimum: 'HALL_MANAGER' | 'ADMIN' | 'SUPER_ADMIN'): void {
  if (authority[role] < authority[minimum]) throw new ForbiddenException('Insufficient authority');
}

export function assertPortalRole(role: Role, portal: 'OPERATIONS' | 'GOVERNANCE'): void {
  if ((portal === 'GOVERNANCE') !== (role === 'SUPER_ADMIN')) {
    throw new UnauthorizedException('This account is not authorized for this portal');
  }
}
