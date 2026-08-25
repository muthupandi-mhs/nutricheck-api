import { z } from 'zod';
import { Instant } from './common';
import { FoodSummary } from './food';
import { QuantityType } from './nutrition';
import { MealSlot } from './logs';

/**
 * Saved meals. The same mechanism as the repeat strip, applied to a group.
 *
 * PLAN calls this the highest-leverage feature nobody asks for: it collapses a
 * three-item log into one tap, which is what makes day 30 feel different from
 * day 1.
 */
export const MealItem = z.object({
  id: z.string().uuid(),
  food: FoodSummary,
  grams: z.number().positive(),
  quantityType: QuantityType,
});
export type MealItem = z.infer<typeof MealItem>;

export const SavedMeal = z.object({
  id: z.string().uuid(),
  name: z.string(),
  items: z.array(MealItem),
  /** Precomputed so the strip can show the payload without a second request. */
  totals: z.object({
    kcal: z.number(),
    proteinG: z.number(),
  }),
  createdAt: Instant,
});
export type SavedMeal = z.infer<typeof SavedMeal>;

export const CreateMealItem = z.object({
  foodId: z.string().uuid(),
  grams: z.number().positive().max(10_000),
  quantityType: QuantityType.default('exact_mass'),
});
export type CreateMealItem = z.infer<typeof CreateMealItem>;

export const CreateMeal = z
  .object({
    name: z.string().trim().min(1).max(80),
    items: z.array(CreateMealItem).min(1).max(25).optional(),
    /** Save an existing log entry as a meal — the "that worked, keep it" path. */
    fromEntryId: z.string().uuid().optional(),
  })
  .refine((m) => Boolean(m.items) !== Boolean(m.fromEntryId), {
    message: 'provide either items or fromEntryId, not both',
  });
export type CreateMeal = z.infer<typeof CreateMeal>;

/** One tap: log every item of a saved meal at its remembered portions. */
export const LogMealRequest = z.object({
  clientId: z.string().uuid(),
  loggedAt: Instant,
  meal: MealSlot,
});
export type LogMealRequest = z.infer<typeof LogMealRequest>;
