import { Inject, Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import type { Pool } from 'pg';
import { DATABASE_POOL } from './database.tokens';

/**
 * Readiness only — never wire this into the liveness probe.
 *
 * A liveness probe that checks the database restarts every pod during a
 * database blip, converting a degradation into an outage. Liveness checks the
 * process; readiness checks the dependencies.
 */
@Injectable()
export class DatabaseHealthIndicator {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async check(key = 'database'): Promise<HealthIndicatorResult> {
    const started = Date.now();
    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }

      return {
        [key]: {
          status: 'up',
          latencyMs: Date.now() - started,
          poolTotal: this.pool.totalCount,
          poolIdle: this.pool.idleCount,
          poolWaiting: this.pool.waitingCount,
        },
      };
    } catch (error) {
      return {
        [key]: {
          status: 'down',
          message: error instanceof Error ? error.message : 'unknown error',
        },
      };
    }
  }
}
