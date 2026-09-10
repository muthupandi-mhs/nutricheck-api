import { Inject, Injectable } from '@nestjs/common';
import type { AdminPageQuery, AdminStepsListResponse } from '@nutricheck/contracts';
import { count, desc, eq, ilike, or, schema, sql, type Database } from '@nutricheck/database';
import { DATABASE } from '../../../infrastructure/database/database.tokens';

/**
 * Every user ranked by their all-time step total — the admin-side view of
 * the same `step_logs` table the app's own `/me/steps` report reads, minus
 * that route's rolling window: an admin auditing the data wants "how much
 * has this person ever logged," not the last 30 days.
 */
@Injectable()
export class AdminStepsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(query: AdminPageQuery): Promise<AdminStepsListResponse> {
    const offset = (query.page - 1) * query.pageSize;
    const search = query.q?.trim();
    const whereClause = search
      ? or(
          ilike(schema.users.email, `%${search}%`),
          ilike(schema.userProfiles.firstName, `%${search}%`),
          ilike(schema.userProfiles.lastName, `%${search}%`),
        )
      : undefined;

    const totalSteps = sql<string>`COALESCE(SUM(${schema.stepLogs.steps}), 0)`;

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          userId: schema.users.id,
          email: schema.users.email,
          firstName: schema.userProfiles.firstName,
          lastName: schema.userProfiles.lastName,
          totalSteps,
          lastLoggedOn: sql<string | null>`MAX(${schema.stepLogs.measuredOn})`,
        })
        .from(schema.users)
        .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
        .leftJoin(schema.stepLogs, eq(schema.stepLogs.userId, schema.users.id))
        .where(whereClause)
        .groupBy(schema.users.id, schema.userProfiles.firstName, schema.userProfiles.lastName)
        .orderBy(desc(totalSteps))
        .limit(query.pageSize)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(schema.users)
        .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
        .where(whereClause),
    ]);

    return {
      items: rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || null,
        totalSteps: Number(r.totalSteps),
        lastLoggedOn: r.lastLoggedOn,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: totalRow?.total ?? 0,
    };
  }
}
