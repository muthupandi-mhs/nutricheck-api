import { z } from 'zod';

/**
 * Fiber has three states, not two. `unknown` is excluded from the day's
 * denominator; treating it as 0 under-reports every day, invisibly.
 * See BACKEND.md §8.3 and PLAN.md §5.
 */
export const FiberState = z.enum(['known', 'imputed', 'unknown']);
export type FiberState = z.infer<typeof FiberState>;

/**
 * A computed nutrient triple. `fiberG` is null if and only if
 * `fiberState === 'unknown'` — enforced by the refinement below, so an
 * inconsistent pair cannot be serialized.
 */
export const Nutrients = z
  .object({
    kcal: z.number().nonnegative(),
    proteinG: z.number().nonnegative(),
    fiberG: z.number().nonnegative().nullable(),
    fiberState: FiberState,
  })
  .refine((n) => (n.fiberState === 'unknown') === (n.fiberG === null), {
    message: "fiberG must be null exactly when fiberState is 'unknown'",
    path: ['fiberG'],
  });
export type Nutrients = z.infer<typeof Nutrients>;

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
