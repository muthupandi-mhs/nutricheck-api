import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Admin-panel operators — entirely separate from `users`.
 *
 * A deliberate second table rather than a role flag on `users`: an admin
 * account is not a nutrition-tracker account that happens to have a
 * privilege, it is a different kind of principal with its own login surface
 * (the admin web app) and its own token issuer (`ADMIN_JWT_SECRET`). Folding
 * the two together would mean every place that reads `users` — search,
 * exports, the resolver's userId joins — has to remember to filter admins
 * back out.
 *
 * No self-registration and so no `auth_identities` row to match against:
 * accounts are created by the `admin:create` script, run by someone who
 * already has database access. That is the access control.
 */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** Argon2id — the same PasswordService the app's own login uses. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('admin_users_email_uq').on(t.email)],
);
