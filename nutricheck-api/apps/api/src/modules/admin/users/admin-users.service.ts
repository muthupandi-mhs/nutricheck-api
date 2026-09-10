import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminPageQuery,
  AdminUserDetail,
  AdminUserListResponse,
} from '@nutricheck/contracts';
import { count, desc, eq, ilike, or, schema, sql, type Database } from '@nutricheck/database';
import { NotFoundProblem } from '../../../common/problems';
import { DATABASE } from '../../../infrastructure/database/database.tokens';
import { AuthService } from '../../auth/auth.service';

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auth: AuthService,
  ) {}

  async list(query: AdminPageQuery): Promise<AdminUserListResponse> {
    const offset = (query.page - 1) * query.pageSize;
    const search = query.q?.trim();
    const whereClause = search
      ? or(
          ilike(schema.users.email, `%${search}%`),
          ilike(schema.userProfiles.firstName, `%${search}%`),
          ilike(schema.userProfiles.lastName, `%${search}%`),
        )
      : undefined;

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          createdAt: schema.users.createdAt,
          deletedAt: schema.users.deletedAt,
          profileUserId: schema.userProfiles.userId,
          firstName: schema.userProfiles.firstName,
          lastName: schema.userProfiles.lastName,
          currentWeightKg: schema.userProfiles.weightKg,
          // Latest goal by effective date — same "newest wins" rule as every
          // other reader of this append-only table.
          goalKcal: sql<number | null>`(
            SELECT g.kcal FROM goals g
            WHERE g.user_id = ${schema.users.id}
            ORDER BY g.effective_from DESC
            LIMIT 1
          )`,
        })
        .from(schema.users)
        .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
        .where(whereClause)
        .orderBy(desc(schema.users.createdAt))
        .limit(query.pageSize)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(schema.users)
        .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
        .where(whereClause),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || null,
        createdAt: row.createdAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        onboarded: row.profileUserId !== null && row.goalKcal !== null,
        currentWeightKg: row.currentWeightKg,
        goalKcal: row.goalKcal,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: totalRow?.total ?? 0,
    };
  }

  async detail(id: string): Promise<AdminUserDetail> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (!user) throw new NotFoundProblem('User');

    const [[profile], [goal], [logCount], [weightCount], [feedbackCount]] = await Promise.all([
      this.db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, id)).limit(1),
      this.db
        .select()
        .from(schema.goals)
        .where(eq(schema.goals.userId, id))
        .orderBy(desc(schema.goals.effectiveFrom))
        .limit(1),
      this.db.select({ n: count() }).from(schema.logEntries).where(eq(schema.logEntries.userId, id)),
      this.db.select({ n: count() }).from(schema.weightLogs).where(eq(schema.weightLogs.userId, id)),
      this.db.select({ n: count() }).from(schema.feedbackReports).where(eq(schema.feedbackReports.userId, id)),
    ]);

    return {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
      deletedAt: user.deletedAt?.toISOString() ?? null,
      profile: profile
        ? {
            firstName: profile.firstName,
            lastName: profile.lastName,
            sex: profile.sex,
            birthDate: profile.birthDate,
            heightCm: profile.heightCm,
            weightKg: profile.weightKg,
            activityLevel: profile.activityLevel,
            objective: profile.objective,
            units: profile.units,
          }
        : null,
      goal: goal
        ? {
            kcal: goal.kcal,
            proteinG: goal.proteinG,
            carbsG: goal.carbsG,
            fatG: goal.fatG,
            fiberG: goal.fiberG,
            effectiveFrom: goal.effectiveFrom,
          }
        : null,
      counts: {
        logEntries: logCount?.n ?? 0,
        weightLogs: weightCount?.n ?? 0,
        feedbackReports: feedbackCount?.n ?? 0,
      },
    };
  }

  /** Delegates to the same soft-delete the account-holder's own DELETE /me uses. */
  async softDelete(id: string): Promise<void> {
    const [user] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (!user) throw new NotFoundProblem('User');
    await this.auth.deleteAccount(id);
  }

  /**
   * Clears `deletedAt`. Not part of AuthService: restoring an account is an
   * admin-only action with no equivalent in the app, so it has no reason to
   * live beside the self-service delete flow.
   */
  async restore(id: string): Promise<void> {
    const [updated] = await this.db
      .update(schema.users)
      .set({ deletedAt: null })
      .where(eq(schema.users.id, id))
      .returning({ id: schema.users.id });

    if (!updated) throw new NotFoundProblem('User');
  }
}
