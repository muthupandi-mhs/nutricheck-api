import { Inject, Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import type Redis from 'ioredis';
import { REDIS_CACHE } from './redis.tokens';

@Injectable()
export class RedisHealthIndicator {
  constructor(@Inject(REDIS_CACHE) private readonly redis: Redis) {}

  async check(key = 'redis'): Promise<HealthIndicatorResult> {
    const started = Date.now();
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        throw new Error(`unexpected PING reply: ${pong}`);
      }
      return {
        [key]: { status: 'up', latencyMs: Date.now() - started },
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
