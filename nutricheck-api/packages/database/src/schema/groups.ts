import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { adminUsers } from './admin';
import { users } from './identity';

/**
 * Walking groups. A user creates one, others join it with the invite code,
 * and its leaderboard is the sum of every member's own `step_logs` rows —
 * there is no group-specific step tracking, only membership.
 */
export const stepGroups = pgTable(
  'step_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    inviteCode: text('invite_code').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('step_groups_invite_code_uq').on(t.inviteCode)],
);

/**
 * The many-to-many join `step_groups` needs: a user can belong to more than
 * one group, so the unique constraint is on the (group, user) pair, not on
 * `userId` alone.
 */
export const stepGroupMembers = pgTable(
  'step_group_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => stepGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('step_group_members_group_user_uq').on(t.groupId, t.userId),
    index('step_group_members_user_idx').on(t.userId),
  ],
);

/**
 * Users an admin has chosen to feature on the public Stars leaderboard.
 * `userId` as the primary key is the same "at most once" guarantee
 * `userProfiles` gets from using `userId` as its own PK — there is no
 * ordering or note to carry, just whether someone is featured.
 */
export const featuredUsers = pgTable('featured_users', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  addedByAdminId: uuid('added_by_admin_id').references(() => adminUsers.id, { onDelete: 'set null' }),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
});
