import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createDatabase, createPool, type Database } from '@nutricheck/database';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { join } from 'node:path';

export interface TestDatabase {
  db: Database;
  pool: Pool;
  url: string;
  stop: () => Promise<void>;
}

/**
 * A real Postgres with pgvector and pg_trgm, migrated from the same SQL that
 * runs in production.
 *
 * Not a shared CI database: parallel jobs against one database produce flakes
 * that get papered over with retries. Not SQLite either — the whole search
 * subsystem is trigram and vector operators that SQLite does not have, so a
 * mock would test nothing worth testing.
 */
export async function startTestPostgres(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'pgvector/pgvector:pg16',
  )
    .withDatabase('nutricheck_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const url = container.getConnectionUri();
  const pool = createPool({ url, poolMax: 4 });
  const db = createDatabase(pool);

  // The extensions are created by docker/initdb in the local stack and by a DBA
  // step in production. Neither applies to a throwaway container, so do it here.
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  await migrate(db, {
    migrationsFolder: join(__dirname, '..', '..', '..', 'packages', 'database', 'migrations'),
  });

  return {
    db,
    pool,
    url,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
