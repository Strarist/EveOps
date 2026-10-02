import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { publishedBuildIdentity } from '@eveops/contracts';
import { publishedDatabaseName } from '@eveops/operations';
import { PrismaService } from './prisma.service';

@SkipThrottle()
@Controller('system')
export class SystemController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  health() {
    const databaseName = publishedDatabaseName();
    return {
      status: 'ok',
      service: 'eveops-api',
      build: publishedBuildIdentity(),
      processId: process.pid,
      time: new Date().toISOString(),
      ...(databaseName ? { databaseName } : {}),
    };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const [heartbeats, outboxBacklog, deadLetteredOutbox, failedExports] = await Promise.all([
        this.prisma.$queryRaw<Array<{ lastSeenAt: Date }>>`SELECT "lastSeenAt" FROM "SystemHeartbeat" WHERE id = 'primary-worker'`,
        this.prisma.outboxEvent.count({ where: { processedAt: null, deadLetteredAt: null } }),
        this.prisma.outboxEvent.count({ where: { deadLetteredAt: { not: null } } }),
        this.prisma.exportJob.count({ where: { status: 'FAILED' } }),
      ]);
      const heartbeat = heartbeats[0];
      const workerAgeSeconds = heartbeat ? Math.floor((Date.now() - heartbeat.lastSeenAt.getTime()) / 1000) : null;
      const ready =
        workerAgeSeconds != null
        && workerAgeSeconds <= 30
        && deadLetteredOutbox === 0
        && failedExports === 0;
      const body = {
        status: ready ? 'ready' : 'degraded',
        build: publishedBuildIdentity(),
        processId: process.pid,
        database: 'connected',
        worker: workerAgeSeconds == null ? 'missing' : workerAgeSeconds <= 30 ? 'healthy' : 'stale',
        workerAgeSeconds,
        outboxBacklog,
        deadLetteredOutbox,
        failedExports,
      };
      if (!ready) throw new ServiceUnavailableException(body);
      return body;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }
}
