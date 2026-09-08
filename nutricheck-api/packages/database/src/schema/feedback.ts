import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { feedbackKindEnum } from './enums';
import { users } from './identity';

/**
 * The QA feedback tab. One row per bug report or feature request, filed from
 * inside the app during a real-time test pass rather than relayed by hand.
 *
 * `screen` and `appVersion` are the two facts a tester almost never thinks to
 * write down themselves and a reviewer almost always needs first — captured
 * automatically so the report is reproducible without a follow-up question.
 *
 * `userId` is nullable on delete rather than cascading: a report about a bug
 * must survive the account that filed it being removed, the same reasoning
 * `matchMisses`/`aiRuns` already use.
 */
export const feedbackReports = pgTable(
  'feedback_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: feedbackKindEnum('kind').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** The route name the reporter was on when they opened the form, if any. */
    screen: text('screen'),
    /** `CFBundleShortVersionString`/`versionName`, whichever platform sent it. */
    appVersion: text('app_version'),
    platform: text('platform'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('feedback_reports_created_idx').on(t.createdAt.desc()),
    index('feedback_reports_kind_idx').on(t.kind),
  ],
);
