import type { PrismaClient } from '@prisma/client';

type DatabaseProbe = Pick<PrismaClient, '$queryRaw'>;

/** Set only after a successful startup check. Unset when the process has not accepted a database. */
let acceptedDatabaseName: string | undefined;

/** Reads the connected database name. Never returns a connection string. */
export async function effectiveDatabaseName(db: DatabaseProbe): Promise<string> {
  const rows = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  const name = rows[0]?.name;
  if (!name) throw new Error('Could not read the effective database name');
  return name;
}

/**
 * Confirms the process is connected to the database named by EVEOPS_REQUIRE_DATABASE.
 * The error names the databases only.
 */
export async function assertEffectiveDatabase(db: DatabaseProbe): Promise<string> {
  const name = await effectiveDatabaseName(db);
  const required = process.env.EVEOPS_REQUIRE_DATABASE?.trim();
  if (required && name !== required) {
    throw new Error(`Refusing to start: effective database is ${name}, required ${required}`);
  }
  acceptedDatabaseName = name;
  return name;
}

/**
 * Name safe to put on an unauthenticated liveness response.
 * Present only when this process was started with a matching EVEOPS_REQUIRE_DATABASE guard.
 * Does not query the database.
 */
export function publishedDatabaseName(): string | undefined {
  const required = process.env.EVEOPS_REQUIRE_DATABASE?.trim();
  if (!required || acceptedDatabaseName !== required) return undefined;
  return acceptedDatabaseName;
}
