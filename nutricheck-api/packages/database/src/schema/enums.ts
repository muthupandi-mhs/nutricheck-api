import { pgEnum } from 'drizzle-orm/pg-core';

export const foodSourceEnum = pgEnum('food_source', [
  'usda_foundation',
  'usda_sr',
  'usda_fndds',
  'off',
  'curated',
  'user',
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

export const activityLevelEnum = pgEnum('activity_level', [
  'sedentary',
  'light',
  'moderate',
  'active',
  'very_active',
]);

export const objectiveEnum = pgEnum('objective', ['lose', 'maintain', 'gain']);

export const authProviderEnum = pgEnum('auth_provider', ['apple', 'google', 'email']);

export const aiStepEnum = pgEnum('ai_step', ['parse', 'rerank']);
