import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * `ai` is distinct from `user` on purpose. Both are rows one person owns, but
 * `user` is a food somebody typed the numbers for and `ai` is one a model
 * estimated them for, and telling those apart later is the difference between
 * auditing model output and guessing which rows to audit. It also keeps
 * "how much of this database did a model write" a one-line query.
 */
export const foodSourceEnum = pgEnum('food_source', [
  'usda_foundation',
  'usda_sr',
  'usda_fndds',
  'off',
  'curated',
  'user',
  'ai',
]);

/**
 * Fiber is `known`, `imputed`, or `unknown` — never silently zero.
 * NOT NULL everywhere it appears, so every write site must state which it is.
 */
export const fiberStateEnum = pgEnum('fiber_state', ['known', 'imputed', 'unknown']);

/**
 * `photo` is present from the first migration and nothing writes it yet.
 * An unused enum value costs nothing; ALTER TYPE on a hot enum does not.
 */
export const logSourceEnum = pgEnum('log_source', [
  'text',
  'voice',
  'search',
  'repeat',
  'photo',
]);

export const mealSlotEnum = pgEnum('meal_slot', ['breakfast', 'lunch', 'dinner', 'snack']);

export const quantityTypeEnum = pgEnum('quantity_type', [
  'exact_mass',
  'count',
  'standard_measure',
  'personal_unit',
  'none_given',
]);

export const quantitySourceEnum = pgEnum('quantity_source', [
  'stated',
  'food_portion',
  'user_portion',
  'unknown',
]);

export const sexEnum = pgEnum('sex', ['male', 'female']);

/**
 * Six levels.
 *
 * This has moved twice: 0007 dropped 'active' to make four, 0008 put it back
 * and added 'athlete' on top to make six. Adding is the cheap direction --
 * ALTER TYPE ADD VALUE -- and dropping is the expensive one, which is why the
 * middle of that sequence cost a type rebuild and a data migration.
 */
export const activityLevelEnum = pgEnum('activity_level', [
  'sedentary',
  'light',
  'moderate',
  'active',
  'very_active',
  'athlete',
]);

export const objectiveEnum = pgEnum('objective', ['lose', 'maintain', 'gain']);

export const authProviderEnum = pgEnum('auth_provider', ['apple', 'google', 'email']);

/**
 * `insight` and `identify` are added ahead of their writers, on the same
 * reasoning as `photo` above: an unused value costs nothing, ALTER TYPE on a
 * hot enum does not.
 *
 * `insight` is not merely unused — the insight endpoint calls the model TODAY
 * and records nothing, so those calls are invisible to cost attribution and,
 * worse, do not count toward RESOLVE_USER_DAILY_SPEND_USD. The ceiling has a
 * hole in it until insights.service.ts records like the resolver does. The
 * enum value is here so that fix is a one-line change rather than a migration.
 */
export const aiStepEnum = pgEnum('ai_step', [
  'parse',
  'rerank',
  'insight',
  'identify',
  'meal',
  'targets',
]);

/**
 * The lifecycle of a model-proposed name → food mapping.
 *
 * `proposed` is what the model wrote. `confirmed` and `rejected` are what users
 * did with it. `promoted` means it earned a row in food_aliases and search can
 * finally see it — which is the only state that changes anyone else's results.
 */
export const aiMatchStatusEnum = pgEnum('ai_match_status', [
  'proposed',
  'confirmed',
  'rejected',
  'promoted',
]);
