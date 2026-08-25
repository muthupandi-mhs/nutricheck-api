import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, schema, sql, type Database } from '@nutricheck/database';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { AppConfig } from '../../config/config.schema';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { REDIS_CACHE } from '../../infrastructure/redis/redis.tokens';

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  resetAt: Date;
  /** Independent of the call count: a per-user daily ceiling on actual spend. */
  spendUsd: number;
  spendLimitUsd: number;
  blocked: boolean;
  reason: 'calls' | 'spend' | null;
}

/**
 * Two independent limits on the AI route.
 *
 * The call quota is the product decision — how many AI-assisted logs a tier
 * gets. The spend ceiling is the safety net: the API key is the asset here, and
 * a proxy without a spend ceiling is an open one. A pathological phrase that
 * costs fifty times the average would pass a call quota and still needs to be
 * stopped.
 *
 * Neither applies to search or the repeat strip. The app never fully stops.
 */
@Injectable()
export class QuotaService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_CACHE) private readonly redis: Redis,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get callLimit(): number {
    return this.config.get('RESOLVE_DAILY_QUOTA', { infer: true });
  }

  private get spendLimit(): number {
    return this.config.get('RESOLVE_USER_DAILY_SPEND_USD', { infer: true });
  }

  async status(userId: string): Promise<QuotaStatus> {
    const [used, spendUsd] = await Promise.all([
      this.usedToday(userId),
      this.spentToday(userId),
    ]);

    const limit = this.callLimit;
    const spendLimitUsd = this.spendLimit;

    const overCalls = limit > 0 && used >= limit;
    const overSpend = spendLimitUsd > 0 && spendUsd >= spendLimitUsd;

    return {
      limit,
      used,
      remaining: Math.max(limit - used, 0),
      resetAt: nextMidnightUtc(),
      spendUsd,
      spendLimitUsd,
      blocked: overCalls || overSpend,
      reason: overCalls ? 'calls' : overSpend ? 'spend' : null,
    };
  }

  /**
   * Counted in Redis rather than derived from ai_runs on every request: the
   * guard runs before each resolve and must not put an aggregate query on the
   * hot path. The key expires at midnight so there is nothing to sweep.
   */
  async consume(userId: string): Promise<void> {
    const key = this.key(userId);
    const used = await this.redis.incr(key);
    if (used === 1) {
      await this.redis.expireat(key, Math.floor(nextMidnightUtc().getTime() / 1000));
    }
  }

  /** Called when a resolve fails upstream — a failed call should not cost a quota unit. */
  async refund(userId: string): Promise<void> {
    const key = this.key(userId);
    const used = await this.redis.decr(key);
    if (used < 0) await this.redis.set(key, 0);
  }

  private async usedToday(userId: string): Promise<number> {
    const value = await this.redis.get(this.key(userId));
    return value ? Number(value) : 0;
  }

  /**
   * Spend comes from ai_runs, not Redis: it is the authoritative record, it
   * survives a cache flush, and this query runs once per resolve rather than
   * once per request to the whole API.
   */
  private async spentToday(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${schema.aiRuns.costUsd}), 0)` })
      .from(schema.aiRuns)
      .where(
        and(
          eq(schema.aiRuns.userId, userId),
          gte(schema.aiRuns.createdAt, startOfTodayUtc()),
        ),
      );

    return Number(row?.total ?? 0);
  }

  private key(userId: string): string {
    return `quota:resolve:${todayUtc()}:${userId}`;
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function startOfTodayUtc(): Date {
  return new Date(`${todayUtc()}T00:00:00.000Z`);
}

function nextMidnightUtc(): Date {
  const next = startOfTodayUtc();
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
