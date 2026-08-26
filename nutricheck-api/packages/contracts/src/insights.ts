import { z } from 'zod';
import { LocalDate } from './common';
import { MealSlot } from './logs';

/**
 * The note shown under a meal once it is logged.
 *
 * Two halves, and the split is the point. `facts` is arithmetic done in
 * Postgres over frozen log values; `text` is a sentence a model wrote ABOUT
 * those facts. The model is given the numbers and forbidden from computing any,
 * because a model doing its own arithmetic states a wrong figure with exactly
 * the same confidence as a right one.
 *
 * It also means the feature degrades instead of disappearing. With no API key,
 * no network, or a model that refused, `text` is empty and `facts` is still
 * complete — the screen renders the numbers and simply says less.
 */

/** How a share reads when the underlying target is not set. */
export const MacroShare = z.object({
  /** This meal's amount. Null when nothing in the meal measured it. */
  amount: z.number().nullable(),
  /** The day's target for this nutrient. */
  target: z.number().nullable(),
  /** amount / target as a percentage, rounded. Null when either side is missing. */
  percentOfTarget: z.number().nullable(),
  /**
   * How many items in this meal had no measurement for it.
   *
   * Carried rather than folded into the amount: an unmeasured nutrient is not a
   * zero, and a note that says "no fibre in that meal" when three items were
   * simply never measured is a lie the user cannot see through.
   */
  unmeasuredItems: z.number().int().nonnegative(),
});
export type MacroShare = z.infer<typeof MacroShare>;

export const MealFacts = z.object({
  meal: MealSlot,
  date: LocalDate,
  /** Entries in this meal slot. Zero means there is nothing to write about. */
  entryCount: z.number().int().nonnegative(),
  kcal: MacroShare,
  proteinG: MacroShare,
  carbsG: MacroShare,
  fatG: MacroShare,
  fiberG: MacroShare,
  /**
   * What is left of the day's targets after EVERY entry, not just this meal.
   * Negative when the target is already passed — reported, never clamped.
   */
  remaining: z.object({
    kcal: z.number().nullable(),
    proteinG: z.number().nullable(),
    carbsG: z.number().nullable(),
    fatG: z.number().nullable(),
    fiberG: z.number().nullable(),
  }),
});
export type MealFacts = z.infer<typeof MealFacts>;

export const MealInsight = z.object({
  facts: MealFacts,
  /**
   * One or two sentences. EMPTY when the model was unavailable, refused, or the
   * meal has nothing logged — the client renders the facts and no prose rather
   * than an error.
   */
  text: z.string(),
  /** Served from cache. A meal's note is stable until the meal changes. */
  cached: z.boolean(),
  model: z.string().nullable(),
});
export type MealInsight = z.infer<typeof MealInsight>;

export const MealInsightQuery = z.object({
  date: LocalDate,
  meal: MealSlot,
  /** IANA zone; the day boundary is the user's, exactly as for a day view. */
  tz: z.string().min(1).default('UTC'),
});
export type MealInsightQuery = z.infer<typeof MealInsightQuery>;
