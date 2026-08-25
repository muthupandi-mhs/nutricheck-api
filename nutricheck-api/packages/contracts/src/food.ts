import { z } from 'zod';
import { CursorPage, paginated } from './common';
import { FiberState } from './nutrition';

export const FoodSource = z.enum(['usda_foundation', 'usda_sr', 'usda_fndds', 'off', 'curated', 'user']);
export type FoodSource = z.infer<typeof FoodSource>;

/** Per 100 g, as stored. All display arithmetic derives from these three numbers. */
export const FoodNutrientsPer100g = z.object({
  kcal: z.number().nonnegative(),
  proteinG: z.number().nonnegative(),
  fiberG: z.number().nonnegative().nullable(),
  fiberState: FiberState,
});
export type FoodNutrientsPer100g = z.infer<typeof FoodNutrientsPer100g>;

export const FoodPortion = z.object({
  label: z.string(),
  grams: z.number().positive(),
  isDefault: z.boolean(),
});
export type FoodPortion = z.infer<typeof FoodPortion>;

/**
 * The compact projection used in search results and resolver candidate lists.
 *
 * Deliberately small: this shape is serialized into the re-rank prompt, where
 * it is the largest uncached input in the pipeline (BACKEND.md §7.4). Adding a
 * description or a brand chain here costs real money on every AI-backed log.
 */
export const FoodSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  kcalPer100g: z.number().nonnegative(),
});
export type FoodSummary = z.infer<typeof FoodSummary>;

export const FoodDetail = FoodSummary.extend({
  source: FoodSource,
  isGeneric: z.boolean(),
  nutrients: FoodNutrientsPer100g,
  portions: z.array(FoodPortion),
});
export type FoodDetail = z.infer<typeof FoodDetail>;

export const FoodSearchQuery = CursorPage.extend({
  q: z.string().trim().min(1).max(120),
});
export type FoodSearchQuery = z.infer<typeof FoodSearchQuery>;

export const FoodSearchResult = FoodSummary.extend({
  proteinPer100g: z.number().nonnegative(),
  /** Set when the row is one of the user's own foods or a food they have logged. */
  familiarity: z.enum(['custom', 'logged', 'none']),
  defaultPortion: FoodPortion.nullable(),
});
export type FoodSearchResult = z.infer<typeof FoodSearchResult>;

export const FoodSearchResponse = paginated(FoodSearchResult);
export type FoodSearchResponse = z.infer<typeof FoodSearchResponse>;

export const CreateCustomFood = z.object({
  name: z.string().trim().min(1).max(120),
  brand: z.string().trim().max(120).nullable().default(null),
  per100g: FoodNutrientsPer100g,
  defaultPortionGrams: z.number().positive().nullable().default(null),
});
export type CreateCustomFood = z.infer<typeof CreateCustomFood>;
