import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthController, SessionGuard } from './auth';
import { ManagementController, ManagementService } from './management';
import { PrismaService } from './prisma.service';
import { RealtimeService } from './realtime';
import { TicketController, TicketService } from './tickets';
import { WorkforceController, WorkforceService } from './workforce';
import { SystemController } from './system';
import { NotificationController } from './notifications';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
  ],
  controllers: [SystemController, AuthController, TicketController, ManagementController, WorkforceController, NotificationController],
  providers: [
    PrismaService,
    RealtimeService,
    TicketService,
    ManagementService,
    WorkforceService,
    SessionGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
