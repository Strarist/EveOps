import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const root = resolve(import.meta.dirname, '..');
const migrationsRoot = resolve(root, 'prisma/migrations');
const reconciliation = JSON.parse(await readFile(resolve(root, 'prisma/migration-reconciliations.json'), 'utf8'));
const migrationNames = (await readdir(migrationsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const prisma = new PrismaClient();
try {
  const rows = await prisma.$queryRaw`
    SELECT migration_name AS "migrationName", checksum
    FROM "_prisma_migrations"
    WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
  `;
  const applied = new Map(rows.map((row) => [row.migrationName, row.checksum]));
  const errors = [];
  const acceptedReconciliations = [];

  for (const migrationName of migrationNames) {
    const contents = await readFile(resolve(migrationsRoot, migrationName, 'migration.sql'));
    const current = createHash('sha256').update(contents).digest('hex');
    const appliedChecksum = applied.get(migrationName);
    if (!appliedChecksum) {
      errors.push(`${migrationName} has not been applied`);
      continue;
    }
    if (appliedChecksum === current) continue;
    const record = reconciliation[migrationName];
    if (
      record?.applied === appliedChecksum &&
      record.current === current &&
      applied.has(record.repairedBy)
    ) {
      acceptedReconciliations.push(`${migrationName} -> ${record.repairedBy}`);
      continue;
    }
    errors.push(`${migrationName} checksum differs from the applied migration`);
  }

  for (const migrationName of applied.keys()) {
    if (!migrationNames.includes(migrationName)) errors.push(`${migrationName} is applied but missing from the repository`);
  }

  if (errors.length) throw new Error(errors.join('\n'));
  if (acceptedReconciliations.length) {
    console.warn(`Accepted documented historical reconciliations:\n${acceptedReconciliations.join('\n')}`);
  }
  console.log(`Migration preflight passed for ${migrationNames.length} migrations.`);
} finally {
  await prisma.$disconnect();
}
