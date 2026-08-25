import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { foods } from './corpus';
import {
  activityLevelEnum,
  authProviderEnum,
  objectiveEnum,
  sexEnum,
} from './enums';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The login identifier. Normalized to lowercase by the contract before it
     * ever reaches here, so a plain unique index is sufficient — no citext, no
     * functional index to keep in sync with the query.
     */
    email: text('email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum('provider').notNull(),
    /** `sub` from the provider's id_token, or the email for password auth. */
    subject: text('subject').notNull(),
    /** Argon2id hash. Null for social providers. */
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_subject_uq').on(t.provider, t.subject),
    index('auth_identities_user_id_idx').on(t.userId),
  ],
);

/**
 * Rotating refresh tokens. Only the SHA-256 hash is stored.
 *
 * `familyId` groups a rotation chain: presenting a token that has already been
 * rotated (`replacedBy` set) means the token leaked, so the whole family is
 * revoked rather than just that one token.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    replacedBy: uuid('replaced_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  sex: sexEnum('sex').notNull(),
  birthDate: date('birth_date').notNull(),
  heightCm: doublePrecision('height_cm').notNull(),
  weightKg: doublePrecision('weight_kg').notNull(),
  activityLevel: activityLevelEnum('activity_level').notNull(),
  objective: objectiveEnum('objective').notNull(),
  rateKgPerWeek: doublePrecision('rate_kg_per_week').default(0).notNull(),
  units: text('units').default('metric').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Append-only. A day view resolves the row with the greatest `effectiveFrom`
 * that is <= that date. Updating in place would retroactively turn last month's
 * "you hit your target" into a miss.
 */
export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kcal: integer('kcal').notNull(),
    proteinG: integer('protein_g').notNull(),
    fiberG: integer('fiber_g').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    /** The visible math: bmr, tdee, activityFactor, adjustmentPct, flooredAtBmr. */
    basis: jsonb('basis').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('goals_user_effective_idx').on(t.userId, t.effectiveFrom.desc()),
    uniqueIndex('goals_user_effective_uq').on(t.userId, t.effectiveFrom),
  ],
);

/**
 * Learned personal units — "your bowl of dal" = 210 g.
 *
 * Promoted from mitigation to mechanism now that photo is parked: this is the
 * primary way a vague unit becomes a number, and it is prefilled into the parse
 * prompt BEFORE the model sees the phrase.
 */
export const userPortions = pgTable(
  'user_portions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    unitLabel: text('unit_label').notNull(),
    /** Null = the unit applies to any food ("my bowl"); set = food-specific. */
    foodId: uuid('food_id').references(() => foods.id, { onDelete: 'cascade' }),
    grams: doublePrecision('grams').notNull(),
    nCorrections: integer('n_corrections').default(1).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('user_portions_uq').on(t.userId, t.unitLabel, t.foodId),
    index('user_portions_user_idx').on(t.userId),
  ],
);
