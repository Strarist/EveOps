import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
const required = process.env.EVEOPS_REQUIRE_DATABASE?.trim() || 'eveops_regression';

if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new Client({ connectionString });
await client.connect();
try {
  const result = await client.query('SELECT current_database() AS name');
  const name = result.rows[0]?.name;
  console.log(`Effective database: ${name}`);
  if (name !== required) {
    console.error(`Refusing to continue: effective database is ${name}, required ${required}`);
    process.exit(1);
  }
} finally {
  await client.end();
}
