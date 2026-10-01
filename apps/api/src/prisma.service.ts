import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertEffectiveDatabase } from '@eveops/operations';
import { ensureDemoSeed, shouldEnsureDemoSeed } from './demo-seed';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    const databaseName = await assertEffectiveDatabase(this);
    this.logger.log(`Effective database: ${databaseName}`);
    if (databaseName === 'eveops_regression') {
      this.logger.log('Demo seed skipped on eveops_regression');
      return;
    }
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
