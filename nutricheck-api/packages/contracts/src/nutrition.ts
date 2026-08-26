import { z } from 'zod';

/**
 * How much to trust one number.
 *
 * Three states, not two. `unknown` is excluded from the day's denominator;
 * treating it as 0 under-reports every day, invisibly. `imputed` is a real
 * value from an estimate rather than a measurement — the UI shows those with a
 * `~` so the uncertainty reaches the user instead of stopping at the database.
 * See BACKEND.md §8.3 and PLAN.md §5.
 */
export const NutrientState = z.enum(['known', 'imputed', 'unknown']);
export type NutrientState = z.infer<typeof NutrientState>;

/** The original name. Fiber is the nutrient this was written for. */
export const FiberState = NutrientState;
export type FiberState = NutrientState;

/**
 * The macro set.
 *
 * `kcal` and `proteinG` are never null: SR Legacy reports both for 100% of its
 * 7,793 foods, and both are goal-bearing, so a missing one is a corpus bug
 * rather than a state to render.
 *
 * Carbs, fat and fibre each carry their own state because they can each be
 * genuinely absent, and at different rates — measured against the real corpus,
 * carbs and fat are present for 100% of SR Legacy rows while fibre is present
 * for 92.8%. Curated dishes are `imputed` across the board. Every one of these
 * is null if and only if its state is `unknown`, enforced below so an
 * inconsistent pair cannot be serialized at all.
 */
export const Nutrients = z
  .object({
    kcal: z.number().nonnegative(),
    proteinG: z.number().nonnegative(),
    carbsG: z.number().nonnegative().nullable(),
    carbsState: NutrientState,
    fatG: z.number().nonnegative().nullable(),
    fatState: NutrientState,
    fiberG: z.number().nonnegative().nullable(),
    fiberState: NutrientState,
  })
  .refine((n) => (n.fiberState === 'unknown') === (n.fiberG === null), {
    message: "fiberG must be null exactly when fiberState is 'unknown'",
    path: ['fiberG'],
  })
  .refine((n) => (n.carbsState === 'unknown') === (n.carbsG === null), {
    message: "carbsG must be null exactly when carbsState is 'unknown'",
    path: ['carbsG'],
  })
  .refine((n) => (n.fatState === 'unknown') === (n.fatG === null), {
    message: "fatG must be null exactly when fatState is 'unknown'",
    path: ['fatG'],
  });
export type Nutrients = z.infer<typeof Nutrients>;

/**
 * Atwater factors, used to derive carbohydrate by difference.
 *
 * This is how USDA itself defines nutrient 1005, "Carbohydrate, by difference",
 * so deriving a curated dish's carbs the same way is the published method
 * rather than a shortcut: given calories, protein and fat, carbohydrate is
 * whatever energy is left over.
 *
 * It is only ever applied to values that are ALREADY estimates, and the result
 * is marked `imputed` like its inputs. It must never be used to manufacture a
 * number that looks measured.
 */
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;

export function carbsByDifference(
  kcal: number,
  proteinG: number,
  fatG: number,
): number {
  const fromProtein = proteinG * KCAL_PER_G.protein;
  const fromFat = fatG * KCAL_PER_G.fat;
  // Clamped at zero: rounding across three estimates can put the remainder
  // slightly negative, and a negative carbohydrate is worse than a zero.
  return Math.max(0, (kcal - fromProtein - fromFat) / KCAL_PER_G.carbs);
}

/**
 * How the amount was expressed. This field drives every branch of the confirm
 * sheet (USER-FLOWS §7), which is why it is recorded rather than normalized away.
 */
export const QuantityType = z.enum([
  /** "180 g chicken" — exact, straight to arithmetic. */
  'exact_mass',
  /** "two rotis" — needs a per-unit gram weight from food_portions. */
  'count',
  /** "a cup of rice" — a standard household measure. */
  'standard_measure',
  /** "a bowl of dal" — resolved per user from user_portions. */
  'personal_unit',
  /** "some nuts" — no amount stated. Ask; never invent one. */
  'none_given',
]);
export type QuantityType = z.infer<typeof QuantityType>;

export const QuantitySource = z.enum([
  'stated',
  'food_portion',
  'user_portion',
  'unknown',
]);
export type QuantitySource = z.infer<typeof QuantitySource>;

/**
 * Invariants asserted here rather than trusted to callers:
 *
 *  1. `grams` is null exactly when the amount is unknown — `none_given`, or a
 *     personal unit not yet learned. Nothing substitutes a default.
 *  2. `range` is non-null ONLY for an unlearned personal unit. A range on
 *     "180 g chicken" is noise; a range on an unlearned "bowl" is honesty.
 */
export const Quantity = z
  .object({
    type: QuantityType,
    raw: z.string().min(1),
    grams: z.number().positive().nullable(),
    source: QuantitySource,
    range: z.tuple([z.number().positive(), z.number().positive()]).nullable(),
  })
  .refine((q) => q.type !== 'none_given' || q.grams === null, {
    message: "grams must be null when type is 'none_given'",
    path: ['grams'],
  })
  .refine((q) => (q.grams === null) === (q.source === 'unknown'), {
    message: "source must be 'unknown' exactly when grams is null",
    path: ['source'],
  })
  .refine(
    (q) => q.range === null || (q.type === 'personal_unit' && q.source !== 'user_portion'),
    {
      message: 'range is only valid for a personal_unit that has not been learned yet',
      path: ['range'],
    },
  )
  .refine((q) => q.range === null || q.range[0] < q.range[1], {
    message: 'range must be ascending',
    path: ['range'],
  });
export type Quantity = z.infer<typeof Quantity>;
