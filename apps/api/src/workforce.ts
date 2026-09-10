import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthScope, Role } from '@eveops/contracts';
import { Availability, Prisma, UserStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { hash } from 'bcryptjs';
import { CurrentScope, SessionGuard } from './auth';
import { assertScope, assertTransition, requireAuthority } from './domain';
import { PrismaService } from './prisma.service';
import { RealtimeService } from './realtime';
import { TicketService } from './tickets';
import { correlationId } from './request-context';

const MANAGED_ROLES = ['STAFF', 'HALL_MANAGER', 'STALL', 'ADMIN'] as const;
type ManagedRole = (typeof MANAGED_ROLES)[number];
const EMPLOYEE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
const ROLE_CODE_PREFIX: Record<ManagedRole, string> = {
  STAFF: 'STF',
  HALL_MANAGER: 'HM',
  STALL: 'STL',
  ADMIN: 'ADM',
};

export class AvailabilityDto {
  @IsIn(['ON_DUTY', 'PAUSED', 'OFF_DUTY'])
  value!: Availability;
}

export class CreatePersonDto {
  @IsString() @MinLength(2) name!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() phone?: string;
  @IsString() @MinLength(10) password!: string;
  @IsIn([...MANAGED_ROLES]) role!: ManagedRole;
  @IsString() eventId!: string;
  @IsOptional() @IsString() hallId?: string;
  @IsOptional() @IsString() stallId?: string;
  @IsOptional() @IsString() serviceCategory?: string;
  @IsOptional() @IsString() serviceSubtype?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) capacity?: number;
  @IsOptional() @Matches(EMPLOYEE_CODE_PATTERN) employeeCode?: string;
}

export class UpdatePersonDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: UserStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) capacity?: number;
  @IsOptional() @IsString() @MinLength(10) password?: string;
  @IsOptional() @IsString() hallId?: string;
  @IsOptional() @IsString() serviceCategory?: string;
  @IsOptional() @IsString() serviceSubtype?: string;
}

export class ReassignDto {
  @IsString() @MinLength(1) staffId!: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class RejectPersonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

@Injectable()
export class WorkforceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketService,
    private readonly realtime?: RealtimeService,
  ) {}

  private notifyWorkforceChange(eventId: string, hallId?: string | null) {
    this.realtime?.publish({
      eventId,
      hallId: hallId ?? undefined,
      type: 'workforce.updated',
      data: { eventId, hallId: hallId ?? null },
    });
  }

  private async writeWorkforceOutbox(
    tx: Prisma.TransactionClient,
    data: { eventId: string; hallId?: string | null; aggregateId: string; eventType: string },
  ) {
    await tx.outboxEvent.create({
      data: {
        eventId: data.eventId,
        aggregateType: 'Workforce',
        aggregateId: data.aggregateId,
        eventType: 'workforce.updated',
        payload: {
          eventId: data.eventId,
          hallId: data.hallId ?? null,
          action: data.eventType,
          targetUserId: data.aggregateId,
        },
      },
    });
  }

  private allowedCreateRoles(actorRole: Role): ManagedRole[] {
    if (actorRole === 'SUPER_ADMIN') return ['ADMIN', 'HALL_MANAGER', 'STAFF', 'STALL'];
    if (actorRole === 'ADMIN') return ['HALL_MANAGER', 'STAFF', 'STALL'];
    if (actorRole === 'HALL_MANAGER') return ['STAFF'];
    return [];
  }

  private staffCodePrefix(category?: string) {
    if (category === 'ELECTRICAL') return 'ELEC';
    if (category === 'HOUSE_HELP') return 'HELP';
    return 'STF';
  }

  private async nextServiceEmployeeCode(tx: Prisma.TransactionClient, category: string) {
    const prefix = this.staffCodePrefix(category);
    const latest = await tx.user.findFirst({
      where: { employeeCode: { startsWith: `${prefix}-` } },
      orderBy: { employeeCode: 'desc' },
      select: { employeeCode: true },
    });
    const current = latest?.employeeCode?.match(new RegExp(`^${prefix}-(\\d+)$`))?.[1];
    const next = (current ? Number(current) : 0) + 1;
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }

  private assertCanManageRole(scope: AuthScope, role: ManagedRole) {
    if (!this.allowedCreateRoles(scope.role).includes(role)) {
      throw new ForbiddenException(`You cannot manage ${role} identities`);
    }
  }

  private async actorOrganization(scope: AuthScope) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: scope.userId },
      select: { organizationId: true },
    });
  }

  private async nextEmployeeCode(tx: Prisma.TransactionClient, role: ManagedRole) {
    const prefix = ROLE_CODE_PREFIX[role];
    const latest = await tx.user.findFirst({
      where: { employeeCode: { startsWith: `${prefix}-` } },
      orderBy: { employeeCode: 'desc' },
      select: { employeeCode: true },
    });
    const current = latest?.employeeCode?.match(new RegExp(`^${prefix}-(\\d+)$`))?.[1];
    const next = (current ? Number(current) : 0) + 1;
    return `${prefix}-${String(next).padStart(5, '0')}`;
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    data: {
      organizationId: string;
      eventId?: string | null;
      actorId: string;
      targetUserId?: string | null;
      action: string;
      metadata?: Prisma.InputJsonValue;
    },
  ) {
    await tx.managementAudit.create({
      data: {
        organizationId: data.organizationId,
        eventId: data.eventId ?? null,
        actorId: data.actorId,
        targetUserId: data.targetUserId ?? null,
        action: data.action,
        metadata: data.metadata ?? undefined,
      },
    });
  }

  async list(scope: AuthScope) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    const memberships = await this.prisma.workforceMembership.findMany({
      where: {
        pool: {
          eventId: { in: scope.eventIds },
          ...(scope.role === 'HALL_MANAGER' ? { hallId: { in: scope.hallIds } } : {}),
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            employeeCode: true,
            status: true,
            role: true,
            approvalStatus: true,
            requestedById: true,
            approvedAt: true,
            rejectedAt: true,
            rejectionReason: true,
            createdAt: true,
            requestedBy: { select: { id: true, name: true, employeeCode: true } },
            _count: { select: { assignments: { where: { status: { in: ['ACTIVE', 'ACCEPTED'] } } } } },
          },
        },
        pool: { select: { id: true, category: true, subtype: true, hallId: true } },
      },
      orderBy: [{ availability: 'asc' }, { lastAvailableAt: 'asc' }],
    });
    return memberships.map((membership) => ({
      ...membership,
      capacity: membership.capacity,
      activeAssignmentCount: membership.user._count.assignments,
      user: {
        id: membership.user.id,
        name: membership.user.name,
        phone: membership.user.phone,
        email: membership.user.email,
        employeeCode: membership.user.employeeCode,
        status: membership.user.status,
        role: membership.user.role,
        approvalStatus: membership.user.approvalStatus,
        requestedById: membership.user.requestedById,
        requestedBy: membership.user.requestedBy,
        approvedAt: membership.user.approvedAt,
        rejectedAt: membership.user.rejectedAt,
        rejectionReason: membership.user.rejectionReason,
        createdAt: membership.user.createdAt,
      },
    }));
  }

  async listPending(scope: AuthScope) {
    requireAuthority(scope.role, 'ADMIN');
    const actor = await this.actorOrganization(scope);
    const users = await this.prisma.user.findMany({
      where: {
        organizationId: actor.organizationId,
        role: 'STAFF',
        approvalStatus: 'PENDING_APPROVAL',
        scopes: {
          some: {
            eventId: { in: scope.eventIds },
            ...(scope.role === 'HALL_MANAGER' ? { hallId: { in: scope.hallIds } } : {}),
          },
        },
      },
      include: {
        requestedBy: { select: { id: true, name: true, employeeCode: true } },
        scopes: { select: { eventId: true, hallId: true, serviceType: true } },
        workforceMemberships: { include: { pool: { select: { category: true, subtype: true, hallId: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((user) => ({
      id: user.id,
      employeeCode: user.employeeCode,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      approvalStatus: user.approvalStatus,
      createdAt: user.createdAt,
      requestedBy: user.requestedBy,
      scopes: user.scopes,
      memberships: user.workforceMemberships.map((membership) => ({
        capacity: membership.capacity,
        availability: membership.availability,
        pool: membership.pool,
      })),
    }));
  }

  async approvePerson(scope: AuthScope, id: string) {
    requireAuthority(scope.role, 'ADMIN');
    const { actor, user } = await this.managedTarget(scope, id);
    if (user.approvalStatus !== 'PENDING_APPROVAL') {
      throw new ConflictException('Staff request has already been reviewed');
    }
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: { id: user.id, approvalStatus: 'PENDING_APPROVAL' },
        data: {
          approvalStatus: 'APPROVED',
          approvedById: scope.userId,
          approvedAt: now,
          rejectedById: null,
          rejectedAt: null,
          rejectionReason: null,
        },
      });
      if (result.count !== 1) throw new ConflictException('Staff request has already been reviewed');
      const person = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        select: {
          id: true,
          employeeCode: true,
          name: true,
          email: true,
          role: true,
          status: true,
          approvalStatus: true,
          approvedAt: true,
          requestedById: true,
        },
      });
      await this.writeAudit(tx, {
        organizationId: actor.organizationId,
        eventId: user.scopes[0]?.eventId ?? null,
        actorId: scope.userId,
        targetUserId: user.id,
        action: 'STAFF_APPROVED',
        metadata: { employeeCode: person.employeeCode },
      });
      if (person.requestedById) {
        await tx.notification.create({
          data: {
            eventId: user.scopes[0]?.eventId ?? scope.eventIds[0],
            recipientId: person.requestedById,
            type: 'STAFF_APPROVED',
            dedupeKey: `staff_approved:${person.id}:${person.requestedById}:${now.toISOString()}`,
            payload: { targetUserId: person.id, employeeCode: person.employeeCode, name: person.name },
          },
        });
      }
      const eventId = user.scopes[0]?.eventId ?? scope.eventIds[0];
      if (eventId) {
        await this.writeWorkforceOutbox(tx, {
          eventId,
          hallId: user.scopes[0]?.hallId,
          aggregateId: person.id,
          eventType: 'STAFF_APPROVED',
        });
      }
      return person;
    });
    if (user.scopes[0]?.eventId) this.notifyWorkforceChange(user.scopes[0].eventId, user.scopes[0].hallId);
    return updated;
  }

  async rejectPerson(scope: AuthScope, id: string, reason: string) {
    requireAuthority(scope.role, 'ADMIN');
    if (!reason?.trim()) throw new BadRequestException('A rejection reason is required');
    const { actor, user } = await this.managedTarget(scope, id);
    if (user.approvalStatus !== 'PENDING_APPROVAL') {
      throw new ConflictException('Staff request has already been reviewed');
    }
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: { id: user.id, approvalStatus: 'PENDING_APPROVAL' },
        data: {
          approvalStatus: 'REJECTED',
          rejectedById: scope.userId,
          rejectedAt: now,
          rejectionReason: reason.trim(),
          approvedById: null,
          approvedAt: null,
        },
      });
      if (result.count !== 1) throw new ConflictException('Staff request has already been reviewed');
      await tx.workforceMembership.updateMany({
        where: { userId: user.id },
        data: { availability: 'OFF_DUTY' },
      });
      const person = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        select: {
          id: true,
          employeeCode: true,
          name: true,
          email: true,
          role: true,
          status: true,
          approvalStatus: true,
          rejectionReason: true,
          rejectedAt: true,
          requestedById: true,
        },
      });
      await this.writeAudit(tx, {
        organizationId: actor.organizationId,
        eventId: user.scopes[0]?.eventId ?? null,
        actorId: scope.userId,
        targetUserId: user.id,
        action: 'STAFF_REJECTED',
        metadata: { employeeCode: person.employeeCode, reason: reason.trim() },
      });
      if (person.requestedById) {
        await tx.notification.create({
          data: {
            eventId: user.scopes[0]?.eventId ?? scope.eventIds[0],
            recipientId: person.requestedById,
            type: 'STAFF_REJECTED',
            dedupeKey: `staff_rejected:${person.id}:${person.requestedById}:${now.toISOString()}`,
            payload: { targetUserId: person.id, employeeCode: person.employeeCode, reason: reason.trim() },
          },
        });
      }
      const eventId = user.scopes[0]?.eventId ?? scope.eventIds[0];
      if (eventId) {
        await this.writeWorkforceOutbox(tx, {
          eventId,
          hallId: user.scopes[0]?.hallId,
          aggregateId: person.id,
          eventType: 'STAFF_REJECTED',
        });
      }
      return person;
    }).then((person) => {
      if (user.scopes[0]?.eventId) this.notifyWorkforceChange(user.scopes[0].eventId, user.scopes[0].hallId);
      return person;
    });
  }

  async mine(scope: AuthScope) {
    if (scope.role !== 'STAFF') throw new BadRequestException('Staff profile is unavailable');
    const [memberships, activeCount, completedCandidates] = await Promise.all([
      this.prisma.workforceMembership.findMany({
        where: { userId: scope.userId, eventId: { in: scope.eventIds } },
        select: { availability: true, capacity: true, pool: { select: { category: true, subtype: true } } },
      }),
      this.prisma.assignment.count({ where: { staffId: scope.userId, status: { in: ['ACTIVE', 'ACCEPTED'] } } }),
      this.prisma.assignment.findMany({
        where: { staffId: scope.userId, releasedAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) }, releaseReason: 'OTP verified' },
        select: { releasedAt: true, ticket: { select: { event: { select: { timezone: true } } } } },
      }),
    ]);
    const completedToday = completedCandidates.filter((assignment) => {
      if (!assignment.releasedAt) return false;
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: assignment.ticket.event.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return formatter.format(assignment.releasedAt) === formatter.format(new Date());
    }).length;
    return {
      availability: memberships[0]?.availability ?? 'OFF_DUTY',
      activeCount,
      completedToday,
      capacity: memberships.reduce((maximum, membership) => Math.max(maximum, membership.capacity), 0),
      services: memberships.map((membership) => membership.pool),
    };
  }

  async availability(scope: AuthScope, value: Availability) {
    if (scope.role !== 'STAFF') throw new BadRequestException('Only staff can set availability');
    if (!value) throw new BadRequestException('Availability value is required');
    if (!['ON_DUTY', 'PAUSED', 'OFF_DUTY'].includes(value)) {
      throw new BadRequestException('Staff may only set ON_DUTY, PAUSED, or OFF_DUTY');
    }
    const memberships = await this.prisma.workforceMembership.findMany({
      where: { userId: scope.userId, pool: { eventId: { in: scope.eventIds } } },
    });
    if (!memberships.length) throw new BadRequestException('No workforce membership configured');

    // PAUSED / OFF_DUTY must not release active assignments — only flip availability.
    await this.prisma.workforceMembership.updateMany({
      where: { id: { in: memberships.map((item) => item.id) } },
      data: { availability: value, ...(value === 'ON_DUTY' ? { lastAvailableAt: new Date() } : {}) },
    });

    let routingWarning: string | undefined;
    if (value === 'ON_DUTY') {
      try {
        for (const membership of memberships) {
          for (let slot = 0; slot < membership.capacity; slot += 1) {
            const waiting = await this.prisma.ticket.findFirst({
              where: { poolId: membership.poolId, status: 'QUEUED' },
              orderBy: [{ queuePriorityOverrideAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
            });
            if (!waiting) break;
            const before = waiting.version;
            const routed = await this.tickets.route(waiting.id, scope.userId);
            if (routed.version === before) break;
          }
        }
      } catch {
        routingWarning = 'Availability updated, but queued work could not be drained automatically';
      }
    }
    return routingWarning ? { availability: value, routingWarning } : { availability: value };
  }

  async createPerson(scope: AuthScope, dto: CreatePersonDto) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    this.assertCanManageRole(scope, dto.role);
    assertScope(scope, { eventId: dto.eventId, hallId: dto.hallId, stallId: dto.stallId });
    if (scope.role === 'HALL_MANAGER' && dto.hallId && !scope.hallIds.includes(dto.hallId)) {
      throw new ForbiddenException('Hall is outside your management scope');
    }

    const actor = await this.actorOrganization(scope);
    const event = await this.prisma.event.findFirst({
      where: { id: dto.eventId, organizationId: actor.organizationId, status: { in: ['DRAFT', 'ACTIVE'] } },
      select: { id: true },
    });
    if (!event) throw new ForbiddenException('Event is outside your organization or is no longer manageable');

    const capacity = dto.capacity ?? 1;
    let scopeRows: Array<{ eventId: string; hallId?: string; stallId?: string; serviceType?: string }> = [];
    let membershipRows: Array<{ eventId: string; poolId: string; capacity: number }> = [];

    if (dto.role === 'ADMIN') {
      scopeRows = [{ eventId: dto.eventId }];
    } else if (dto.role === 'STALL') {
      if (!dto.stallId) throw new BadRequestException('A Stall identity requires a stall');
      const stall = await this.prisma.stall.findFirst({
        where: { id: dto.stallId, eventId: dto.eventId, active: true, zone: { active: true, hall: { active: true } } },
        select: { id: true, zone: { select: { hallId: true } } },
      });
      if (!stall) throw new BadRequestException('A valid active stall is required');
      if (scope.role === 'HALL_MANAGER' && !scope.hallIds.includes(stall.zone.hallId)) {
        throw new ForbiddenException('Hall is outside your management scope');
      }
      if (dto.hallId && dto.hallId !== stall.zone.hallId) throw new BadRequestException('Stall does not belong to the selected hall');
      scopeRows = [{ eventId: dto.eventId, hallId: stall.zone.hallId, stallId: stall.id }];
    } else if (dto.role === 'HALL_MANAGER') {
      if (!dto.hallId) throw new BadRequestException('Hall Manager requires a hall');
      const hall = await this.prisma.hall.findFirst({ where: { id: dto.hallId, eventId: dto.eventId, active: true }, select: { id: true } });
      if (!hall) throw new BadRequestException('A valid active hall is required');
      const pools = await this.prisma.servicePool.findMany({
        where: { eventId: dto.eventId, hallId: dto.hallId, category: 'HALL_MANAGER', active: true },
        select: { id: true },
      });
      if (!pools.length) throw new BadRequestException('At least one Hall Manager service pool is required');
      scopeRows = [{ eventId: dto.eventId, hallId: dto.hallId }];
      membershipRows = pools.map((pool) => ({ eventId: dto.eventId, poolId: pool.id, capacity }));
    } else {
      if (!dto.hallId) throw new BadRequestException('Staff requires a hall');
      if (!dto.serviceCategory || !dto.serviceSubtype) {
        throw new BadRequestException('Staff requires serviceCategory and serviceSubtype');
      }
      if (dto.serviceCategory === 'HALL_MANAGER') {
        throw new BadRequestException('Staff cannot join a Hall Manager service pool');
      }
      if (scope.role === 'HALL_MANAGER' && !['ELECTRICAL', 'HOUSE_HELP'].includes(dto.serviceCategory)) {
        throw new ForbiddenException('Hall Managers can create Electrical or House Help staff only');
      }
      const hall = await this.prisma.hall.findFirst({ where: { id: dto.hallId, eventId: dto.eventId, active: true }, select: { id: true } });
      if (!hall) throw new BadRequestException('A valid active hall is required');
      const pool = await this.prisma.servicePool.findFirst({
        where: {
          eventId: dto.eventId,
          hallId: dto.hallId,
          category: dto.serviceCategory,
          subtype: dto.serviceSubtype,
          active: true,
        },
        select: { id: true, category: true },
      });
      if (!pool) throw new BadRequestException('No matching service pool for the selected hall and service');
      scopeRows = [{ eventId: dto.eventId, hallId: dto.hallId, serviceType: pool.category }];
      membershipRows = [{ eventId: dto.eventId, poolId: pool.id, capacity }];
    }

    const requiresApproval = scope.role === 'HALL_MANAGER' && dto.role === 'STAFF';
    const passwordHash = await hash(dto.password, 12);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const employeeCode = dto.employeeCode?.trim().toUpperCase()
          ?? (dto.role === 'STAFF' && dto.serviceCategory
            ? await this.nextServiceEmployeeCode(tx, dto.serviceCategory)
            : await this.nextEmployeeCode(tx, dto.role));
        const now = new Date();
        const user = await tx.user.create({
          data: {
            organizationId: actor.organizationId,
            employeeCode,
            name: dto.name.trim(),
            email: dto.email.trim().toLowerCase(),
            phone: dto.phone?.trim() || null,
            passwordHash,
            mustChangePassword: true,
            role: dto.role,
            status: 'ACTIVE',
            approvalStatus: requiresApproval ? 'PENDING_APPROVAL' : 'APPROVED',
            requestedById: requiresApproval ? scope.userId : null,
            approvedById: requiresApproval ? null : scope.userId,
            approvedAt: requiresApproval ? null : now,
            scopes: { create: scopeRows },
            workforceMemberships: {
              create: membershipRows.map((row) => ({
                ...row,
                availability: 'OFF_DUTY' as Availability,
              })),
            },
          },
          select: {
            id: true,
            employeeCode: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            status: true,
            approvalStatus: true,
            requestedById: true,
            approvedAt: true,
          },
        });
        await this.writeAudit(tx, {
          organizationId: actor.organizationId,
          eventId: dto.eventId,
          actorId: scope.userId,
          targetUserId: user.id,
          action: requiresApproval ? 'STAFF_APPROVAL_REQUESTED' : 'STAFF_CREATED',
          metadata: {
            role: user.role,
            employeeCode: user.employeeCode,
            hallId: dto.hallId ?? null,
            stallId: dto.stallId ?? null,
            serviceCategory: dto.serviceCategory ?? null,
            serviceSubtype: dto.serviceSubtype ?? null,
            approvalStatus: user.approvalStatus,
          },
        });
        if (requiresApproval) {
          const admins = await tx.user.findMany({
            where: {
              organizationId: actor.organizationId,
              role: { in: ['ADMIN', 'SUPER_ADMIN'] },
              status: 'ACTIVE',
              approvalStatus: 'APPROVED',
              scopes: { some: { eventId: dto.eventId } },
            },
            select: { id: true },
          });
          if (admins.length) {
            await tx.notification.createMany({
              data: admins.map((admin) => ({
                eventId: dto.eventId,
                recipientId: admin.id,
                type: 'STAFF_APPROVAL_REQUESTED',
                dedupeKey: `staff_approval_requested:${user.id}:${admin.id}`,
                payload: {
                  targetUserId: user.id,
                  employeeCode: user.employeeCode,
                  name: user.name,
                  hallId: dto.hallId ?? null,
                  serviceCategory: dto.serviceCategory ?? null,
                },
              })),
              skipDuplicates: true,
            });
          }
        }
        await this.writeWorkforceOutbox(tx, {
          eventId: dto.eventId,
          hallId: dto.hallId,
          aggregateId: user.id,
          eventType: requiresApproval ? 'STAFF_APPROVAL_REQUESTED' : 'STAFF_CREATED',
        });
        return user;
      });
      this.notifyWorkforceChange(dto.eventId, dto.hallId);
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target) ? error.meta.target.map(String) : [];
        if (target.some((field) => field.toLowerCase().includes('employeecode'))) {
          throw new ConflictException(`Employee code ${dto.employeeCode?.trim().toUpperCase() ?? ''} already exists.`);
        }
        if (target.some((field) => field.toLowerCase().includes('email'))) {
          throw new ConflictException('Email is already in use');
        }
        throw new ConflictException('Email or employee code is already in use');
      }
      throw error;
    }
  }

  private async managedTarget(scope: AuthScope, id: string) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    const actor = await this.actorOrganization(scope);
    const user = await this.prisma.user.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: {
        scopes: true,
        workforceMemberships: { include: { pool: { select: { id: true, category: true, subtype: true, hallId: true } } } },
      },
    });
    if (!user) throw new NotFoundException('User is unavailable');
    if (user.role === 'SUPER_ADMIN') throw new ForbiddenException('You cannot manage SuperAdmin identities');
    if (!MANAGED_ROLES.includes(user.role as ManagedRole)) throw new ForbiddenException('You cannot manage this role');
    this.assertCanManageRole(scope, user.role as ManagedRole);
    const authorized = user.scopes.some((targetScope) =>
      scope.eventIds.includes(targetScope.eventId)
      && (scope.role !== 'HALL_MANAGER' || (!!targetScope.hallId && scope.hallIds.includes(targetScope.hallId))),
    );
    if (!authorized) throw new ForbiddenException('User is outside your management scope');
    return { actor, user };
  }

  async getPerson(scope: AuthScope, id: string) {
    const { user } = await this.managedTarget(scope, id);
    const activeAssignmentCount = await this.prisma.assignment.count({
      where: { staffId: user.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    });
    return {
      id: user.id,
      employeeCode: user.employeeCode,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      approvalStatus: user.approvalStatus,
      rejectionReason: user.rejectionReason,
      activeAssignmentCount,
      scopes: user.scopes.map((item) => ({
        eventId: item.eventId,
        hallId: item.hallId,
        stallId: item.stallId,
        serviceType: item.serviceType,
      })),
      memberships: user.workforceMemberships.map((membership) => ({
        id: membership.id,
        eventId: membership.eventId,
        capacity: membership.capacity,
        availability: membership.availability,
        pool: membership.pool,
      })),
    };
  }

  async updatePerson(scope: AuthScope, id: string, dto: UpdatePersonDto) {
    const { actor, user } = await this.managedTarget(scope, id);
    const existingScope = user.scopes[0];
    if (!existingScope) throw new ConflictException('Target user has no operational scope');

    const eventId = existingScope.eventId;
    const nextHallId = dto.hallId ?? existingScope.hallId ?? undefined;
    if (scope.role === 'HALL_MANAGER') {
      if (dto.hallId && !scope.hallIds.includes(dto.hallId)) {
        throw new ForbiddenException('Cannot expand hall scope beyond assigned halls');
      }
      if (nextHallId && !scope.hallIds.includes(nextHallId)) {
        throw new ForbiddenException('Hall is outside your management scope');
      }
    }

    const poolChangeRequested = dto.hallId !== undefined || dto.serviceCategory !== undefined || dto.serviceSubtype !== undefined;
    let nextMemberships = user.workforceMemberships.map((membership) => ({
      eventId: membership.eventId,
      poolId: membership.poolId,
      capacity: dto.capacity ?? membership.capacity,
      availability: membership.availability,
    }));
    let nextScopes = user.scopes.map((item) => ({
      eventId: item.eventId,
      hallId: item.hallId ?? undefined,
      stallId: item.stallId ?? undefined,
      serviceType: item.serviceType ?? undefined,
    }));

    if (poolChangeRequested) {
      if (user.role !== 'STAFF') throw new BadRequestException('Service pool changes are only supported for staff');
      if (scope.role === 'HALL_MANAGER' && user.approvalStatus === 'APPROVED') {
        throw new ForbiddenException('Approved staff scope changes require Admin');
      }
      const category = dto.serviceCategory ?? user.workforceMemberships[0]?.pool.category;
      const subtype = dto.serviceSubtype ?? user.workforceMemberships[0]?.pool.subtype;
      if (!nextHallId || !category || !subtype) throw new BadRequestException('Hall and service pool are required to change staff assignment');
      if (category === 'HALL_MANAGER') throw new BadRequestException('Staff cannot join a Hall Manager service pool');
      assertScope(scope, { eventId, hallId: nextHallId });
      const pool = await this.prisma.servicePool.findFirst({
        where: { eventId, hallId: nextHallId, category, subtype, active: true },
        select: { id: true, category: true },
      });
      if (!pool) throw new BadRequestException('No matching service pool for the selected hall and service');
      const activeAssignments = await this.prisma.assignment.count({
        where: { staffId: user.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
      });
      if (activeAssignments > 0) {
        throw new ConflictException('Reassign active tickets before changing this user service pool');
      }
      nextMemberships = [{
        eventId,
        poolId: pool.id,
        capacity: dto.capacity ?? user.workforceMemberships[0]?.capacity ?? 1,
        availability: user.workforceMemberships[0]?.availability ?? 'OFF_DUTY',
      }];
      nextScopes = [{ eventId, hallId: nextHallId, stallId: undefined, serviceType: pool.category }];
    } else if (dto.capacity !== undefined) {
      const activeAssignments = await this.prisma.assignment.count({
        where: { staffId: user.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
      });
      if (dto.capacity < activeAssignments) {
        throw new ConflictException('Capacity cannot be lower than the current active assignment count');
      }
    }

    const scopeChanged = poolChangeRequested
      && (
        (nextHallId ?? null) !== existingScope.hallId
        || nextMemberships[0]?.poolId !== user.workforceMemberships[0]?.poolId
      );
    const capacityChanged = dto.capacity !== undefined
      && dto.capacity !== (user.workforceMemberships[0]?.capacity ?? undefined);
    const deactivated = dto.status === 'DISABLED' && user.status !== 'DISABLED';

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (scopeChanged) {
          await tx.workforceMembership.deleteMany({ where: { userId: user.id } });
          await tx.userScope.deleteMany({ where: { userId: user.id } });
        }
        const updated = await tx.user.update({
          where: { id: user.id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone.trim() || null } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(dto.password !== undefined ? { passwordHash: await hash(dto.password, 12), mustChangePassword: true } : {}),
            ...(scopeChanged ? {
              scopes: { create: nextScopes },
              workforceMemberships: { create: nextMemberships },
            } : dto.capacity !== undefined || deactivated ? {
              workforceMemberships: {
                updateMany: {
                  where: {},
                  data: {
                    ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
                    ...(deactivated ? { availability: 'OFF_DUTY' as Availability } : {}),
                  },
                },
              },
            } : {}),
          },
          select: {
            id: true,
            employeeCode: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            status: true,
          },
        });
        if (deactivated || dto.password !== undefined) {
          await tx.session.deleteMany({ where: { userId: user.id } });
        }

        const actions = ['USER_UPDATED'];
        if (deactivated) actions.push('USER_DEACTIVATED');
        if (capacityChanged) actions.push('CAPACITY_CHANGED');
        if (scopeChanged) actions.push('SCOPE_CHANGED');
        for (const action of actions) {
          await this.writeAudit(tx, {
            organizationId: actor.organizationId,
            eventId,
            actorId: scope.userId,
            targetUserId: user.id,
            action,
            metadata: {
              status: updated.status,
              capacity: dto.capacity ?? user.workforceMemberships[0]?.capacity ?? null,
              hallId: nextHallId ?? null,
            },
          });
        }
        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email or employee code is already in use');
      }
      throw error;
    }
  }

  async reassign(ticketId: string, staffId: string, reason: string, scope: AuthScope) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    if (!reason.trim()) throw new BadRequestException('Reassignment reason is required');
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${ticketId} FOR UPDATE`;
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } });
      assertScope(scope, ticket);
      if (!['ASSIGNED', 'SNOOZED', 'ACCEPTED'].includes(ticket.status)) {
        throw new BadRequestException('Ticket cannot be reassigned from its current state');
      }
      if (ticket.status !== 'ASSIGNED') assertTransition(ticket.status, 'ASSIGNED');
      const pool = await tx.servicePool.findUniqueOrThrow({ where: { id: ticket.poolId! }, select: { category: true } });
      const membership = await tx.workforceMembership.findFirst({
        where: {
          userId: staffId,
          poolId: ticket.poolId ?? undefined,
          availability: 'ON_DUTY',
          user: { role: pool.category === 'HALL_MANAGER' ? 'HALL_MANAGER' : 'STAFF', status: 'ACTIVE', approvalStatus: 'APPROVED' },
        },
      });
      if (!membership) throw new BadRequestException('Staff is not eligible and on duty');
      await tx.$queryRaw`SELECT id FROM "WorkforceMembership" WHERE id = ${membership.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${staffId} FOR UPDATE`;
      const staffLoad = await tx.assignment.count({
        where: { staffId, status: { in: ['ACTIVE', 'ACCEPTED'] }, ticketId: { not: ticketId } },
      });
      if (staffLoad >= membership.capacity) throw new BadRequestException('Staff active-ticket capacity is full');
      const active = await tx.assignment.findFirst({
        where: { ticketId, status: { in: ['ACTIVE', 'ACCEPTED'] } },
      });
      if (active?.staffId === staffId) throw new BadRequestException('Ticket is already assigned to this staff member');
      if (active) {
        const releasedAt = new Date();
        await tx.assignment.update({
          where: { id: active.id },
          data: { status: 'RELEASED', activeTicketKey: null, releasedAt, releaseReason: reason },
        });
        await tx.workforceMembership.updateMany({
          where: { userId: active.staffId },
          data: { lastAvailableAt: releasedAt },
        });
      }
      const assignment = await tx.assignment.create({ data: { eventId: ticket.eventId, ticketId, staffId, activeTicketKey: ticketId } });
      const ticketUpdate = await tx.ticket.updateMany({
        where: { id: ticketId, version: ticket.version, status: ticket.status },
        data: { status: 'ASSIGNED', version: { increment: 1 } },
      });
      if (ticketUpdate.count !== 1) throw new BadRequestException('Ticket changed before reassignment completed');
      await tx.ticketEvent.create({
        data: {
          eventId: ticket.eventId,
          ticketId,
          eventType: 'ASSIGNMENT_REASSIGNED',
          actorId: scope.userId,
          fromStatus: ticket.status,
          toStatus: 'ASSIGNED',
          correlationId: correlationId(),
          metadata: { previousStaffId: active?.staffId, staffId, reason },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: ticket.eventId,
          aggregateType: 'Ticket',
          aggregateId: ticketId,
          eventType: 'ASSIGNMENT_REASSIGNED',
          payload: { ticketId, eventId: ticket.eventId, hallId: ticket.hallId, stallId: ticket.stallId, assigneeId: staffId, previousAssigneeId: active?.staffId ?? null },
        },
      });
      await tx.notification.create({
        data: {
          eventId: ticket.eventId,
          recipientId: staffId,
          ticketId,
          type: 'TICKET_ASSIGNED',
          dedupeKey: `ticket-reassigned:${ticketId}:${assignment.id}:${staffId}`,
          payload: { hallId: ticket.hallId, previousStaffId: active?.staffId ?? null },
        },
      });
      return { assignment, previousStaffId: active?.staffId };
    });
    if (result.previousStaffId && result.previousStaffId !== staffId) {
      const previousPools = await this.prisma.workforceMembership.findMany({
        where: { userId: result.previousStaffId, availability: 'ON_DUTY' },
        select: { poolId: true },
      });
      for (const pool of previousPools) {
        const waiting = await this.prisma.ticket.findFirst({
          where: { poolId: pool.poolId, status: 'QUEUED' },
          orderBy: [{ queuePriorityOverrideAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
        });
        if (waiting) await this.tickets.route(waiting.id, scope.userId);
      }
    }
    return result.assignment;
  }
}

@UseGuards(SessionGuard)
@Controller('workforce')
export class WorkforceController {
  constructor(private readonly service: WorkforceService) {}

  @Get()
  list(@CurrentScope() scope: AuthScope) {
    return this.service.list(scope);
  }

  @Get('pending')
  listPending(@CurrentScope() scope: AuthScope) {
    return this.service.listPending(scope);
  }

  @Get('me')
  mine(@CurrentScope() scope: AuthScope) {
    return this.service.mine(scope);
  }

  @Patch('availability')
  availability(@Body() body: AvailabilityDto, @CurrentScope() scope: AuthScope) {
    return this.service.availability(scope, body.value);
  }

  @Post('people')
  createPerson(@Body() body: CreatePersonDto, @CurrentScope() scope: AuthScope) {
    return this.service.createPerson(scope, body);
  }

  @Get('people/:id')
  getPerson(@Param('id') id: string, @CurrentScope() scope: AuthScope) {
    return this.service.getPerson(scope, id);
  }

  @Patch('people/:id')
  updatePerson(@Param('id') id: string, @Body() body: UpdatePersonDto, @CurrentScope() scope: AuthScope) {
    return this.service.updatePerson(scope, id, body);
  }

  @Post('people/:id/approve')
  approvePerson(@Param('id') id: string, @CurrentScope() scope: AuthScope) {
    return this.service.approvePerson(scope, id);
  }

  @Post('people/:id/reject')
  rejectPerson(@Param('id') id: string, @Body() body: RejectPersonDto, @CurrentScope() scope: AuthScope) {
    return this.service.rejectPerson(scope, id, body.reason);
  }

  @Patch('tickets/:ticketId/reassign')
  reassign(
    @Param('ticketId') ticketId: string,
    @Body() body: ReassignDto,
    @CurrentScope() scope: AuthScope,
  ) {
    return this.service.reassign(ticketId, body.staffId, body.reason, scope);
  }
}
