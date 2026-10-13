import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { IsString, IsUrl, MinLength } from 'class-validator';
import type { AuthScope } from '@eveops/contracts';
import { presentNotification } from '@eveops/operations';
import { CurrentScope, SessionGuard } from './auth';
import { PrismaService } from './prisma.service';

class PushSubscriptionDto {
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true }) endpoint!: string;
  @IsString() @MinLength(8) p256dh!: string;
  @IsString() @MinLength(8) auth!: string;
}

@UseGuards(SessionGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentScope() scope: AuthScope) {
    const rows = await this.prisma.notification.findMany({
      where: { recipientId: scope.userId, eventId: { in: scope.eventIds } },
      orderBy: { sentAt: 'desc' },
      take: 100,
      include: {
        ticket: {
          select: {
            status: true,
            assignments: { where: { status: { in: ['ACTIVE', 'ACCEPTED'] } }, select: { staffId: true } },
          },
        },
      },
    });
    return rows.map((row) => presentNotification(row, scope.role, {
      status: row.ticket?.status ?? null,
      assigneeIds: row.ticket?.assignments.map((assignment) => assignment.staffId) ?? [],
      viewerId: scope.userId,
    }));
  }

  @Get('push-config')
  pushConfig() {
    const publicKey = process.env.VAPID_PUBLIC_KEY ?? null;
    return { configured: Boolean(publicKey && process.env.VAPID_PRIVATE_KEY), publicKey };
  }

  @Get(':id')
  async one(@Param('id') id: string, @CurrentScope() scope: AuthScope) {
    const row = await this.prisma.notification.findFirst({
      where: { id, recipientId: scope.userId, eventId: { in: scope.eventIds } },
      include: {
        ticket: {
          select: {
            status: true,
            assignments: { where: { status: { in: ['ACTIVE', 'ACCEPTED'] } }, select: { staffId: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Alert is unavailable');
    return presentNotification(row, scope.role, {
      status: row.ticket?.status,
      assigneeIds: row.ticket?.assignments.map((assignment) => assignment.staffId),
      viewerId: scope.userId,
    });
  }

  @Post('push-subscription')
  async subscribe(@CurrentScope() scope: AuthScope, @Body() body: PushSubscriptionDto) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      throw new ServiceUnavailableException('Background notifications are not configured on this server');
    }
    const existing = await this.prisma.pushSubscription.findUnique({ where: { endpoint: body.endpoint }, select: { id: true, userId: true } });
    if (existing && existing.userId !== scope.userId) {
      throw new ConflictException('This browser is still registered to another account. Sign out of that account first.');
    }
    if (!existing) {
      const count = await this.prisma.pushSubscription.count({ where: { userId: scope.userId } });
      if (count >= 8) {
        const oldest = await this.prisma.pushSubscription.findFirst({ where: { userId: scope.userId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
        if (oldest) await this.prisma.pushSubscription.delete({ where: { id: oldest.id } });
      }
    }
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: { userId: scope.userId, endpoint: body.endpoint, p256dh: body.p256dh, auth: body.auth },
      update: { p256dh: body.p256dh, auth: body.auth },
    });
    return { saved: true };
  }

  @Delete('push-subscription')
  async unsubscribe(@CurrentScope() scope: AuthScope, @Body() body: PushSubscriptionDto) {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint: body.endpoint, userId: scope.userId } });
    return { removed: true };
  }

  @Patch(':id/read')
  async read(@Param('id') id: string, @CurrentScope() scope: AuthScope) {
    await this.prisma.notification.updateMany({
      where: { id, recipientId: scope.userId, eventId: { in: scope.eventIds } },
      data: { readAt: new Date() },
    });
    return { read: true };
  }
}
