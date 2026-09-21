import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ensureDemoSeed, shouldEnsureDemoSeed } from './demo-seed';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    if (!shouldEnsureDemoSeed()) return;
    try {
      await ensureDemoSeed(this);
      this.logger.log('Demo pilot accounts ensured');
    } catch (error) {
      this.logger.error('Demo seed failed', error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
