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
        // DATABASE_SSL wins when set; otherwise NODE_ENV decides, which is the
        // right default for a managed database and the wrong one for a Postgres
        // container on a private Docker network -- that server speaks no TLS,
        // and the pool is rejected outright. See config.schema.ts.
        const sslOverride = config.get('DATABASE_SSL', { infer: true });
        const useSsl =
          sslOverride ?? config.get('NODE_ENV', { infer: true }) === 'production';

        const pool = createPool({
          url: config.get('DATABASE_URL', { infer: true }),
          poolMax: config.get('DATABASE_POOL_MAX', { infer: true }),
          ssl: useSsl ? { rejectUnauthorized: true } : undefined,
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
