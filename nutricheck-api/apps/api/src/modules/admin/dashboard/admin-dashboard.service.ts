import { Inject, Injectable } from '@nestjs/common';
import type { AdminDashboardStats } from '@nutricheck/contracts';
import { count, gte, isNull, schema, sql, type Database } from '@nutricheck/database';
import { DATABASE } from '../../../infrastructure/database/database.tokens';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminDashboardService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async stats(): Promise<AdminDashboardStats> {
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);
    const startOfToday = startOfTodayUtc();
    const startOfMonth = new Date(Date.UTC(startOfToday.getUTCFullYear(), startOfToday.getUTCMonth(), 1));

    const [
      [totalUsersRow],
      [deletedUsersRow],
      [newUsersRow],
      [activeUsersRow],
      feedbackRows,
      foodRows,
      [aiRunsTodayRow],
      [aiCostTodayRow],
      [aiCostMonthRow],
      [logEntriesTodayRow],
    ] = await Promise.all([
      this.db.select({ n: count() }).from(schema.users).where(isNull(schema.users.deletedAt)),
      this.db.select({ n: count() }).from(schema.users).where(sql`${schema.users.deletedAt} is not null`),
      this.db.select({ n: count() }).from(schema.users).where(gte(schema.users.createdAt, sevenDaysAgo)),
      this.db
        .select({ n: sql<string>`count(distinct ${schema.logEntries.userId})` })
        .from(schema.logEntries)
        .where(gte(schema.logEntries.createdAt, sevenDaysAgo)),
      this.db.select({ kind: schema.feedbackReports.kind, n: count() }).from(schema.feedbackReports).groupBy(schema.feedbackReports.kind),
      this.db.select({ source: schema.foods.source, n: count() }).from(schema.foods).groupBy(schema.foods.source),
      this.db.select({ n: count() }).from(schema.aiRuns).where(gte(schema.aiRuns.createdAt, startOfToday)),
      this.db
        .select({ total: sql<string>`COALESCE(SUM(${schema.aiRuns.costUsd}), 0)` })
        .from(schema.aiRuns)
        .where(gte(schema.aiRuns.createdAt, startOfToday)),
      this.db
        .select({ total: sql<string>`COALESCE(SUM(${schema.aiRuns.costUsd}), 0)` })
        .from(schema.aiRuns)
        .where(gte(schema.aiRuns.createdAt, startOfMonth)),
      this.db.select({ n: count() }).from(schema.logEntries).where(gte(schema.logEntries.createdAt, startOfToday)),
    ]);

    const feedbackByKind = { bug: 0, feature: 0 };
    for (const row of feedbackRows) feedbackByKind[row.kind] = row.n;
    const totalFeedback = feedbackByKind.bug + feedbackByKind.feature;

    const foodsBySource: Record<string, number> = {};
    let totalFoods = 0;
    for (const row of foodRows) {
      foodsBySource[row.source] = row.n;
      totalFoods += row.n;
    }

    return {
      totalUsers: totalUsersRow?.n ?? 0,
      activeUsers7d: Number(activeUsersRow?.n ?? 0),
      newUsers7d: newUsersRow?.n ?? 0,
      deletedUsers: deletedUsersRow?.n ?? 0,
      totalFeedback,
      feedbackByKind,
      totalFoods,
      foodsBySource,
      aiRunsToday: aiRunsTodayRow?.n ?? 0,
      aiCostTodayUsd: Number(aiCostTodayRow?.total ?? 0),
      aiCostMonthUsd: Number(aiCostMonthRow?.total ?? 0),
      logEntriesToday: logEntriesTodayRow?.n ?? 0,
    };
  }
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
