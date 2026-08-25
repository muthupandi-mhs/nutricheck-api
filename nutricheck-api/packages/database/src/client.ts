import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface CreateDatabaseOptions {
  url: string;
  /**
   * Per-process ceiling. poolMax * (api replicas + worker replicas) must stay
   * under the server's max_connections — see BACKEND.md §11.1. Size this from
   * the replica ceiling, not from what one process feels like it needs.
   */
  poolMax?: number;
  ssl?: PoolConfig['ssl'];
  logQueries?: boolean;
}

export function createPool(options: CreateDatabaseOptions): Pool {
  return new Pool({
    connectionString: options.url,
    max: options.poolMax ?? 10,
    ssl: options.ssl,
    // Recycle idle connections so a failed-over primary does not leave the pool
    // holding sockets to a server that is no longer accepting writes.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Fail a query that has been stuck rather than pinning a pool slot forever.
    statement_timeout: 15_000,
    query_timeout: 15_000,
  });
}

export function createDatabase(pool: Pool, logQueries = false): Database {
  return drizzle(pool, { schema, logger: logQueries });
}
