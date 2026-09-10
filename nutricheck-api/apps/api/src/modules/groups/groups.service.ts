import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateGroup,
  GroupDetail,
  JoinGroup,
  MyGroupsResponse,
  StepsLeaderboardEntry,
} from '@nutricheck/contracts';
import { and, eq, schema, sql, type Database } from '@nutricheck/database';
import { ConflictProblem, NotFoundProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { stepsWindow } from '../steps/steps.service';

/** Same rolling window the personal report defaults to — one definition of "recent." */
const LEADERBOARD_WINDOW_DAYS = 30;

/**
 * Walking groups. Anyone can create or join one — there is no admin
 * curation here, unlike Stars. A group tracks membership only; its
 * leaderboard is computed by summing members' own `step_logs` rows, never
 * stored, so there is nothing to keep in sync when someone logs a day late.
 */
@Injectable()
export class GroupsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Creates the group and seats the creator as its first member, in one transaction. */
  async create(userId: string, input: CreateGroup): Promise<GroupDetail> {
    const inviteCode = randomBytes(4).toString('hex').toUpperCase();

    const groupId = await this.db.transaction(async (tx) => {
      const [group] = await tx
        .insert(schema.stepGroups)
        .values({ name: input.name, inviteCode, createdBy: userId })
        .returning({ id: schema.stepGroups.id });
      await tx.insert(schema.stepGroupMembers).values({ groupId: group!.id, userId });
      return group!.id;
    });

    return this.detail(userId, groupId);
  }

  async join(userId: string, input: JoinGroup): Promise<GroupDetail> {
    const [group] = await this.db
      .select({ id: schema.stepGroups.id })
      .from(schema.stepGroups)
      .where(eq(schema.stepGroups.inviteCode, input.inviteCode.trim().toUpperCase()))
      .limit(1);
    if (!group) throw new NotFoundProblem('Group');

    const [existing] = await this.db
      .select({ id: schema.stepGroupMembers.id })
      .from(schema.stepGroupMembers)
      .where(and(eq(schema.stepGroupMembers.groupId, group.id), eq(schema.stepGroupMembers.userId, userId)))
      .limit(1);
    if (existing) {
      throw new ConflictProblem('Already in this group', 'You have already joined this group.');
    }

    await this.db.insert(schema.stepGroupMembers).values({ groupId: group.id, userId });
    return this.detail(userId, group.id);
  }

  /**
   * `yourRank` needs every member's total to rank the caller among them, so
   * this can't reuse the plain member-count query `leaderboardFor` skips —
   * one raw query, ranking within each of the caller's groups at once rather
   * than one leaderboard query per group.
   */
  async myGroups(userId: string): Promise<MyGroupsResponse> {
    const { from, to } = stepsWindow(LEADERBOARD_WINDOW_DAYS);

    const result = await this.db.execute<{
      id: string;
      name: string;
      created_at: string;
      member_count: string;
      your_rank: string;
    }>(sql`
      WITH my_group_ids AS (
        SELECT group_id FROM step_group_members WHERE user_id = ${userId}
      ),
      member_totals AS (
        SELECT
          m.group_id,
          m.user_id,
          COALESCE(SUM(sl.steps), 0) AS total
        FROM step_group_members m
        LEFT JOIN step_logs sl
          ON sl.user_id = m.user_id AND sl.measured_on BETWEEN ${from}::date AND ${to}::date
        WHERE m.group_id IN (SELECT group_id FROM my_group_ids)
        GROUP BY m.group_id, m.user_id
      ),
      ranked AS (
        SELECT group_id, user_id, RANK() OVER (PARTITION BY group_id ORDER BY total DESC) AS rank
        FROM member_totals
      )
      SELECT
        g.id,
        g.name,
        g.created_at,
        (SELECT COUNT(*) FROM step_group_members m2 WHERE m2.group_id = g.id) AS member_count,
        r.rank AS your_rank
      FROM step_groups g
      JOIN ranked r ON r.group_id = g.id AND r.user_id = ${userId}
      WHERE g.id IN (SELECT group_id FROM my_group_ids)
      ORDER BY g.created_at DESC
    `);

    return {
      groups: result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        memberCount: Number(r.member_count),
        yourRank: Number(r.your_rank),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  /** 404s on a group that exists but the caller isn't in — membership, not existence, is what's asked. */
  async detail(userId: string, groupId: string): Promise<GroupDetail> {
    const [group] = await this.db
      .select()
      .from(schema.stepGroups)
      .where(eq(schema.stepGroups.id, groupId))
      .limit(1);
    if (!group) throw new NotFoundProblem('Group');

    const [membership] = await this.db
      .select({ id: schema.stepGroupMembers.id })
      .from(schema.stepGroupMembers)
      .where(and(eq(schema.stepGroupMembers.groupId, groupId), eq(schema.stepGroupMembers.userId, userId)))
      .limit(1);
    if (!membership) throw new NotFoundProblem('Group');

    return {
      id: group.id,
      name: group.name,
      inviteCode: group.inviteCode,
      createdAt: group.createdAt.toISOString(),
      leaderboard: await this.leaderboardFor(groupId),
    };
  }

  async leave(userId: string, groupId: string): Promise<void> {
    const [deleted] = await this.db
      .delete(schema.stepGroupMembers)
      .where(and(eq(schema.stepGroupMembers.groupId, groupId), eq(schema.stepGroupMembers.userId, userId)))
      .returning({ id: schema.stepGroupMembers.id });
    if (!deleted) throw new NotFoundProblem('Group membership');
  }

  /**
   * Every member ranked by steps over the last 30 days — a raw aggregate
   * query, the same shape `LogsService.dayPointsBetween` uses for its own
   * per-day sums, grouped by member instead of by day.
   */
  private async leaderboardFor(groupId: string): Promise<StepsLeaderboardEntry[]> {
    const { from, to } = stepsWindow(LEADERBOARD_WINDOW_DAYS);

    const result = await this.db.execute<{ user_id: string; name: string | null; total: string }>(sql`
      SELECT
        m.user_id,
        NULLIF(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), '') AS name,
        COALESCE(SUM(sl.steps), 0) AS total
      FROM step_group_members m
      LEFT JOIN user_profiles p ON p.user_id = m.user_id
      LEFT JOIN step_logs sl
        ON sl.user_id = m.user_id AND sl.measured_on BETWEEN ${from}::date AND ${to}::date
      WHERE m.group_id = ${groupId}
      GROUP BY m.user_id, p.first_name, p.last_name
      ORDER BY total DESC
    `);

    return result.rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      steps: Number(row.total),
    }));
  }
}
