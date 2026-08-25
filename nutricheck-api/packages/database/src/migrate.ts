/**
 * Migration runner. Runs as a pre-deploy Job / one-shot compose service —
 * never on application boot, where two replicas would race each other.
 *
 *   docker compose run --rm migrate
 *   npm run db:migrate -w @nutricheck/database
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { createDatabase, createPool } from './client';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  // A single connection: migrations are serial, and a pool here only makes the
  // advisory-lock behaviour harder to reason about.
  const pool = createPool({ url, poolMax: 1 });
  const db = createDatabase(pool);

  const migrationsFolder = join(__dirname, '..', 'migrations');
  console.log(`[migrate] applying from ${migrationsFolder}`);

  const started = Date.now();
  try {
    await migrate(db, { migrationsFolder });
    console.log(`[migrate] up to date in ${Date.now() - started}ms`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[migrate] failed:', error);
  process.exitCode = 1;
});
