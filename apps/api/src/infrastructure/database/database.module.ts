import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabase, createPool, type Database } from '@nutricheck/database';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config/config.schema';
import { DatabaseHealthIndicator } from './database.health';
import { DATABASE, DATABASE_POOL } from './database.tokens';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Pool => {
        const pool = createPool({
          url: config.get('DATABASE_URL', { infer: true }),
          poolMax: config.get('DATABASE_POOL_MAX', { infer: true }),
          ssl:
            config.get('NODE_ENV', { infer: true }) === 'production'
              ? { rejectUnauthorized: true }
              : undefined,
        });

        // An idle-client error is emitted on the pool, not on a query. Without
        // this handler Node treats it as an unhandled 'error' event and exits
        // the process — a database blip becomes a crash loop.
        const logger = new Logger('DatabasePool');
        pool.on('error', (error) => {
          logger.error({ err: error }, 'idle client error');
        });

        return pool;
      },
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL, ConfigService],
      useFactory: (pool: Pool, config: ConfigService<AppConfig, true>): Database =>
        createDatabase(pool, config.get('LOG_LEVEL', { infer: true }) === 'trace'),
    },
    DatabaseHealthIndicator,
  ],
  exports: [DATABASE, DATABASE_POOL, DatabaseHealthIndicator],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('draining connection pool');
    await this.pool.end();
  }
}

export { DATABASE, DATABASE_POOL };
