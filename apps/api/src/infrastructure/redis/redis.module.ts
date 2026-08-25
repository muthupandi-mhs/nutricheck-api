import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppConfig } from '../../config/config.schema';
import { RedisHealthIndicator } from './redis.health';
import {
  REDIS_CACHE,
  REDIS_DB_CACHE,
  REDIS_DB_QUEUE,
  REDIS_QUEUE,
} from './redis.tokens';

function buildClient(url: string, db: number, label: string): Redis {
  const logger = new Logger(`Redis:${label}`);

  const client = new Redis(url, {
    db,
    lazyConnect: false,
    // BullMQ requires this to be null on its connections; keeping both clients
    // consistent avoids a surprise when the queue module reuses one.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  // Without an error listener ioredis emits an unhandled 'error' and the
  // process exits on the first reconnect blip.
  client.on('error', (error) => logger.error({ err: error }, 'connection error'));
  client.on('reconnecting', () => logger.warn('reconnecting'));

  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        buildClient(config.get('REDIS_URL', { infer: true }), REDIS_DB_QUEUE, 'queue'),
    },
    {
      provide: REDIS_CACHE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        buildClient(config.get('REDIS_URL', { infer: true }), REDIS_DB_CACHE, 'cache'),
    },
    RedisHealthIndicator,
  ],
  exports: [REDIS_QUEUE, REDIS_CACHE, RedisHealthIndicator],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_QUEUE) private readonly queue: Redis,
    @Inject(REDIS_CACHE) private readonly cache: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.queue.quit(), this.cache.quit()]);
  }
}

export { REDIS_CACHE, REDIS_QUEUE };
