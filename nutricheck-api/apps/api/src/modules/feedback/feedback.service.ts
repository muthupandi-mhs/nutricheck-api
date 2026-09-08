import { Inject, Injectable } from '@nestjs/common';
import type { FeedbackItem, FeedbackList, SubmitFeedbackRequest } from '@nutricheck/contracts';
import { desc, eq, schema, type Database } from '@nutricheck/database';
import { DATABASE } from '../../infrastructure/database/database.tokens';

/**
 * The QA feedback tab's backend. One table, one insert, one list — see
 * `feedback_reports` in packages/database for why it stays this small.
 */
@Injectable()
export class FeedbackService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async submit(userId: string, input: SubmitFeedbackRequest): Promise<FeedbackItem> {
    const [row] = await this.db
      .insert(schema.feedbackReports)
      .values({
        userId,
        kind: input.kind,
        title: input.title,
        description: input.description,
        screen: input.screen ?? null,
        platform: input.platform ?? null,
      })
      .returning();

    return this.toItem(row!, await this.reporterLabel(userId));
  }

  /** Newest first — a reviewer triages the same way anything else gets triaged. */
  async list(): Promise<FeedbackList> {
    const rows = await this.db
      .select({
        report: schema.feedbackReports,
        firstName: schema.userProfiles.firstName,
        lastName: schema.userProfiles.lastName,
        email: schema.users.email,
      })
      .from(schema.feedbackReports)
      .leftJoin(schema.users, eq(schema.users.id, schema.feedbackReports.userId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.feedbackReports.userId))
      .orderBy(desc(schema.feedbackReports.createdAt));

    return rows.map((row) =>
      this.toItem(row.report, this.label(row.firstName, row.lastName, row.email)),
    );
  }

  private async reporterLabel(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({
        firstName: schema.userProfiles.firstName,
        lastName: schema.userProfiles.lastName,
        email: schema.users.email,
      })
      .from(schema.users)
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.users.id))
      .where(eq(schema.users.id, userId));

    return row ? this.label(row.firstName, row.lastName, row.email) : null;
  }

  /** A name when onboarding wrote one, the login email otherwise. */
  private label(firstName: string | null, lastName: string | null, email: string | null): string | null {
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();
    return name || email || null;
  }

  private toItem(row: typeof schema.feedbackReports.$inferSelect, reportedBy: string | null): FeedbackItem {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      screen: row.screen,
      appVersion: row.appVersion,
      platform: row.platform,
      reportedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
