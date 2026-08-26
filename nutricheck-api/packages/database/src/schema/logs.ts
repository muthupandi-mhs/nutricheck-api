import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { foods } from './corpus';
import {
  fiberStateEnum,
  logSourceEnum,
  mealSlotEnum,
  quantitySourceEnum,
  quantityTypeEnum,
} from './enums';
import { users } from './identity';

export const logEntries = pgTable(
  'log_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Device-generated at the moment the user taps commit, before any network
     * call. The unique index below is the whole offline story: a replayed queue
     * returns the original entry instead of creating a second breakfast.
     */
    clientId: uuid('client_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    loggedAt: timestamp('logged_at', { withTimezone: true }).notNull(),
    meal: mealSlotEnum('meal').notNull(),
    source: logSourceEnum('source').notNull(),
    /** The phrase that produced this entry. The reproducible input for a replay. */
    phrase: text('phrase'),
    aiRunId: uuid('ai_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('log_entries_user_client_uq').on(t.userId, t.clientId),
    index('log_entries_user_logged_at_idx').on(t.userId, t.loggedAt.desc()),
  ],
);

/**
 * Nutrients are FROZEN copies, not a join to food_nutrients.
 *
 * This looks like denormalization for speed; it is really about truth. USDA
 * reissues data, you will re-ingest, and you will fix your own curated rows.
 * If history were computed live, a Tuesday in March would silently change
 * months later.
 */
export const logItems = pgTable(
  'log_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => logEntries.id, { onDelete: 'cascade' }),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'restrict' }),
    grams: doublePrecision('grams').notNull(),
    kcal: doublePrecision('kcal').notNull(),
    proteinG: doublePrecision('protein_g').notNull(),
    carbsG: doublePrecision('carbs_g'),
    carbsState: fiberStateEnum('carbs_state').notNull().default('unknown'),
    fatG: doublePrecision('fat_g'),
    fatState: fiberStateEnum('fat_state').notNull().default('unknown'),
    fiberG: doublePrecision('fiber_g'),
    fiberState: fiberStateEnum('fiber_state').notNull(),
    quantityType: quantityTypeEnum('quantity_type').notNull(),
    quantitySource: quantitySourceEnum('quantity_source').notNull(),
  },
  (t) => [
    index('log_items_entry_idx').on(t.entryId),
    index('log_items_food_idx').on(t.foodId),
  ],
);

/** Saved meals — "usual breakfast" collapses a three-item log into one tap. */
export const meals = pgTable(
  'meals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('meals_user_idx').on(t.userId)],
);

export const mealItems = pgTable(
  'meal_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mealId: uuid('meal_id')
      .notNull()
      .references(() => meals.id, { onDelete: 'cascade' }),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'cascade' }),
    grams: doublePrecision('grams').notNull(),
    quantityType: quantityTypeEnum('quantity_type').notNull(),
  },
  (t) => [index('meal_items_meal_idx').on(t.mealId)],
);

/** A phrase that worked, offered as a saved meal on its second use. */
export const userPhrases = pgTable(
  'user_phrases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    phrase: text('phrase').notNull(),
    mealId: uuid('meal_id').references(() => meals.id, { onDelete: 'set null' }),
    useCount: doublePrecision('use_count').default(1).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('user_phrases_uq').on(t.userId, t.phrase)],
);
