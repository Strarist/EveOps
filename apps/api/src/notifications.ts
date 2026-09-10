import { Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import type { AuthScope } from '@eveops/contracts';
import { CurrentScope, SessionGuard } from './auth';
import { PrismaService } from './prisma.service';

@UseGuards(SessionGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@CurrentScope() scope: AuthScope) {
    return this.prisma.notification.findMany({
      where: { recipientId: scope.userId, eventId: { in: scope.eventIds } },
      orderBy: { sentAt: 'desc' },
      take: 100,
    });
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
