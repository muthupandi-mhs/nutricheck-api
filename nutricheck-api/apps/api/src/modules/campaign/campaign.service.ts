import { Inject, Injectable } from '@nestjs/common';
import type { AdminCampaignResponse, AdminSetCampaign, StepsCampaign } from '@nutricheck/contracts';
import { eq, schema, sql, type Database } from '@nutricheck/database';
import { NotFoundProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';

type CampaignConfig = typeof schema.stepCampaign.$inferSelect;
/** What `computeFor` actually needs — loose enough to cover a real row and the synthetic default below. */
type CampaignConfigLike = Pick<CampaignConfig, 'scope' | 'groupId' | 'title' | 'tagline'> & {
  goalSteps: number | null;
};

/** The one row `stepCampaign` ever holds. See the schema's own doc comment for why. */
const SINGLETON_ID = 'default';

/**
 * Stands in for a saved row when nothing has been configured yet — everyone,
 * no goal, no name. The banner is always on; this is what "on" defaults to
 * until an admin points it at a goal or narrows it to one group.
 */
const DEFAULT_CONFIG: CampaignConfigLike = {
  scope: 'all',
  groupId: null,
  goalSteps: null,
  title: null,
  tagline: null,
};

/**
 * Computes the Steps screen's banner from whatever an admin last configured
 * — every user's steps by default, or one group's — against a goal, if one
 * has been set.
 *
 * All-time, not the rolling 30-day window the report and leaderboards use:
 * this is a milestone tally, not a recent-activity figure, so a day
 * dropping off a window must never make the total go backwards.
 */
@Injectable()
export class CampaignService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The banner as the app sees it — always something, see `DEFAULT_CONFIG`. */
  async current(): Promise<StepsCampaign> {
    return this.computeFor((await this.config()) ?? DEFAULT_CONFIG);
  }

  /** The same computed totals, plus the raw config an admin's form needs to re-populate itself. */
  async adminView(): Promise<AdminCampaignResponse> {
    const config = await this.config();
    return {
      campaign: await this.computeFor(config ?? DEFAULT_CONFIG),
      scope: config?.scope ?? null,
      groupId: config?.groupId ?? null,
    };
  }

  async set(adminId: string, input: AdminSetCampaign): Promise<void> {
    const groupId = input.scope === 'group' ? (input.groupId ?? null) : null;

    if (groupId) {
      const [group] = await this.db
        .select({ id: schema.stepGroups.id })
        .from(schema.stepGroups)
        .where(eq(schema.stepGroups.id, groupId))
        .limit(1);
      if (!group) throw new NotFoundProblem('Group');
    }

    const row = {
      id: SINGLETON_ID,
      scope: input.scope,
      groupId,
      goalSteps: input.goalSteps,
      title: input.title ?? null,
      tagline: input.tagline ?? null,
      updatedByAdminId: adminId,
      updatedAt: new Date(),
    };

    await this.db.insert(schema.stepCampaign).values(row).onConflictDoUpdate({
      target: schema.stepCampaign.id,
      set: row,
    });
  }

  /** Idempotent — clearing an already-off banner is a no-op, not a 404. */
  async clear(): Promise<void> {
    await this.db.delete(schema.stepCampaign).where(eq(schema.stepCampaign.id, SINGLETON_ID));
  }

  private async config(): Promise<CampaignConfig | null> {
    const [config] = await this.db
      .select()
      .from(schema.stepCampaign)
      .where(eq(schema.stepCampaign.id, SINGLETON_ID))
      .limit(1);
    return config ?? null;
  }

  private async computeFor(config: CampaignConfigLike): Promise<StepsCampaign> {
    const shared = { title: config.title, tagline: config.tagline, goalSteps: config.goalSteps };

    if (config.scope === 'all') {
      const { rows } = await this.db.execute<{ total: string; participants: string }>(sql`
        SELECT COALESCE(SUM(steps), 0) AS total, COUNT(DISTINCT user_id) AS participants FROM step_logs
      `);
      return {
        ...shared,
        scope: 'all',
        totalSteps: Number(rows[0]?.total ?? 0),
        participantCount: Number(rows[0]?.participants ?? 0),
        groupName: null,
      };
    }

    // scope === 'group'. A vanished group deletes this row via ON DELETE
    // CASCADE, so `groupId` here is always live — but a defensive null
    // check costs nothing against a type that only claims it in TypeScript.
    const [group] = await this.db
      .select({ name: schema.stepGroups.name })
      .from(schema.stepGroups)
      .where(eq(schema.stepGroups.id, config.groupId ?? ''))
      .limit(1);

    const { rows } = await this.db.execute<{ total: string; participants: string }>(sql`
      SELECT COALESCE(SUM(sl.steps), 0) AS total, COUNT(DISTINCT m.user_id) AS participants
      FROM step_group_members m
      LEFT JOIN step_logs sl ON sl.user_id = m.user_id
      WHERE m.group_id = ${config.groupId}
    `);

    return {
      ...shared,
      scope: 'group',
      totalSteps: Number(rows[0]?.total ?? 0),
      participantCount: Number(rows[0]?.participants ?? 0),
      groupName: group?.name ?? null,
    };
  }
}
