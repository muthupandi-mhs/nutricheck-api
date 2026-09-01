import { sql } from 'drizzle-orm';
import {
  check,
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
  /**
   * What to call them. Nullable, and not because the app is unsure it wants a
   * name — the onboarding step asks for one on the way in. Every account that
   * existed before that step did is a row with no name in it, and a NOT NULL
   * here would either fail the migration or invent a default that the user then
   * has to notice and correct.
   *
   * No index and no uniqueness: this is display text, never an identifier. The
   * email is the identifier and always was.
   */
  firstName: text('first_name'),
  /** Asked for beside the first, never required — a surname earns no feature. */
  lastName: text('last_name'),
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
    carbsG: integer('carbs_g').notNull().default(0),
    fatG: integer('fat_g').notNull().default(0),
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

/**
 * One weight per day — the history the profile's single `weight_kg` cannot hold.
 *
 * `user_profiles.weight_kg` stays as the CURRENT weight rather than being
 * replaced by a lookup here. Every goal calculation, AI prompt and targets
 * preview reads that column, and a join for a number that changes monthly is
 * work done on every request to save a write done occasionally. The two are
 * kept in step at both doors instead: logging a weight for the latest date
 * writes the profile, and saving the profile writes a row here.
 *
 * Unique on (user, day) because a weight is a measurement OF a day, not an
 * event in it. Somebody who steps on the scale twice on Tuesday has corrected
 * Tuesday; they have not recorded two Tuesdays. That makes the write an upsert
 * and makes a replayed request harmless.
 *
 * One index, not two. The unique constraint's btree serves the descending scan
 * the series query does — Postgres reads an index backwards at the same cost —
 * so a second `(user_id, measured_on DESC)` index would be a write to maintain
 * for a read that is already covered.
 */
export const weightLogs = pgTable(
  'weight_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The LOCAL day the user weighed themselves, sent by the client. Not
     * derived from `createdAt`: somebody in Auckland logging Monday's weight
     * would otherwise have it filed under Sunday for the rest of time.
     */
    measuredOn: date('measured_on').notNull(),
    weightKg: doublePrecision('weight_kg').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('weight_logs_user_date_uq').on(t.userId, t.measuredOn)],
);

/**
 * Declared fasts — a start, an end, and the length somebody was aiming for.
 *
 * **Instants, not dates.** `weight_logs` above is keyed by a local `date`
 * because a weight is a measurement OF a day; a fast is an interval on the
 * clock whose length is the entire point, so both ends are `timestamptz`.
 * Filing one under a day would mean choosing between the day it started and
 * the day it finished, and a sixteen-hour fast usually spans both.
 *
 * **Nothing here is derived from the food log.** The app can already say how
 * long it has been since the last entry, and that gap is not this: this table
 * only ever holds intervals somebody explicitly began. Inferring rows from
 * meal times would fill the history with fasts nobody kept — including the one
 * that runs every night while they are asleep.
 *
 * **`ended_at IS NULL` is the running state, and there is no status column.**
 * A status and a timestamp are two spellings of the same fact, and holding
 * both is a chance to write them down inconsistently.
 *
 * **At most one open fast per user, enforced here rather than in the service.**
 * The partial unique index is what makes that true under concurrency: a
 * check-then-insert lets two taps a few milliseconds apart both find nothing
 * open and both start one, leaving a user with two timers and no way to say
 * which is theirs. The service still checks first — for the error message —
 * and treats a 23505 from this index as the authority.
 *
 * **`target_hours` is the plan.** There is no plan enum: "16:8" is a name for
 * a sixteen-hour fast, and the label is looked up from `FASTING_PLANS` in the
 * contracts by both ends. A slug stored beside the hours would be a second
 * fact that can disagree with the first.
 */
export const fastingSessions = pgTable(
  'fasting_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    /** Null while it is running. Set once, when the user ends it. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    targetHours: integer('target_hours').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('fasting_sessions_open_uq')
      .on(t.userId)
      .where(sql`${t.endedAt} is null`),
    /**
     * The history scan, newest first. Not covered by the index above, which
     * only sees open rows — the list this screen draws is entirely closed
     * ones, and there is exactly one open row to find.
     */
    index('fasting_sessions_user_started_idx').on(t.userId, t.startedAt.desc()),
    /**
     * A fast that ends before it starts is a negative duration, and a negative
     * duration would sit in the average and the "longest" figure forever. The
     * service refuses it too, with a message; this is the guarantee that
     * survives a bug in the service.
     */
    check('fasting_sessions_span_ck', sql`${t.endedAt} is null or ${t.endedAt} > ${t.startedAt}`),
  ],
);
