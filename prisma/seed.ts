import { PrismaClient } from '@prisma/client';
import { ensureDemoSeed, shouldEnsureDemoSeed } from '../apps/api/src/demo-seed';

const prisma = new PrismaClient();
async function main() {
  if (!shouldEnsureDemoSeed()) {
    console.log('Skipping demo seed (ALLOW_DEMO_SEED=false).');
    return;
  }
  await ensureDemoSeed(prisma);
  console.log('Demo seed complete.');
}
main().finally(() => prisma.$disconnect());
