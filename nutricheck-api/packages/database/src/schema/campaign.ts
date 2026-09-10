import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin';
import { stepGroups } from './groups';

export const stepCampaignScope = pgEnum('step_campaign_scope', ['all', 'group']);

/**
 * The one banner shown at the top of the Steps screen — a total against a
 * goal, scoped to either every user or a single group. Singleton by
 * construction: `id` is always the literal `'default'`, so admin sets it
 * with an upsert (same shape as `admin:create`'s "re-run to update" rule)
 * rather than a create/list/delete surface over rows that only ever number
 * zero or one. No row at all means the banner is off.
 */
export const stepCampaign = pgTable('step_campaign', {
  id: text('id').primaryKey().default('default'),
  scope: stepCampaignScope('scope').notNull(),
  /** Set when `scope` is `'group'`; null for `'all'`. */
  groupId: uuid('group_id').references(() => stepGroups.id, { onDelete: 'cascade' }),
  goalSteps: integer('goal_steps').notNull(),
  title: text('title'),
  tagline: text('tagline'),
  updatedByAdminId: uuid('updated_by_admin_id').references(() => adminUsers.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
