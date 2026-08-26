import type { Nutrients, NutrientState } from '@nutricheck/contracts';

/**
 * Nutrition is arithmetic, not generation.
 *
 * Every displayed number comes from here: per_100g x grams / 100. The model
 * never emits a nutrient value, and neither does the client — the request
 * carries food_id and grams, and this computes the rest server-side so two
 * clients can never disagree about what a Tuesday contained.
 */

export interface Per100g {
  kcal: number;
  proteinG: number;
  /** Each is null exactly when its own state is 'unknown'. */
  carbsG: number | null;
  carbsState: NutrientState;
  fatG: number | null;
  fatState: NutrientState;
  fiberG: number | null;
  fiberState: NutrientState;
}

/** Scales one value, carrying its state. An unknown stays unknown. */
function scale(
  value: number | null,
  state: NutrientState,
  factor: number,
): number | null {
  return state === 'unknown' || value === null ? null : round2(value * factor);
}

/**
 * Values are rounded to two decimals on the way in.
 *
 * Not cosmetic: these are stored and summed, and unrounded IEEE-754 products
 * accumulate visible drift over a few hundred entries — a day total that ends
 * in .0000000004 is a bug report waiting to happen.
 */
export function computeItemNutrients(per100g: Per100g, grams: number): Nutrients {
  if (!Number.isFinite(grams) || grams <= 0) {
    throw new RangeError(`grams must be a positive number, received ${grams}`);
  }

  const factor = grams / 100;

  // Each nutrient carries its state through the arithmetic. An unknown stays
  // unknown: multiplying a missing measurement by a portion does not measure it.
  return {
    kcal: round2(per100g.kcal * factor),
    proteinG: round2(per100g.proteinG * factor),
    carbsG: scale(per100g.carbsG, per100g.carbsState, factor),
    carbsState: per100g.carbsState,
    fatG: scale(per100g.fatG, per100g.fatState, factor),
    fatState: per100g.fatState,
    fiberG: scale(per100g.fiberG, per100g.fiberState, factor),
    fiberState: per100g.fiberState,
  };
}

export interface DayTotals {
  kcal: number;
  proteinG: number;
  /** Each is the sum over items whose own state is known or imputed. */
  carbsG: number;
  fatG: number;
  fiberG: number;
  /**
   * How many items were excluded from each sum, counted separately. Displayed,
   * never hidden. One count could not say which total to distrust — the item
   * missing fibre is usually not the item missing carbs.
   */
  carbsUnmeasuredItems: number;
  fatUnmeasuredItems: number;
  fiberUnmeasuredItems: number;
}

/**
 * Day totals.
 *
 * Unknown fiber is EXCLUDED from the sum and counted separately, so the ring
 * can read "8 g of 28 g, 2 items unmeasured" instead of quietly claiming zero.
 * Treating unknown as 0 under-reports the headline number every single day and
 * gives no signal that it is doing so.
 */
export function sumDay(items: readonly Nutrients[]): DayTotals {
  let kcal = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  let fiberG = 0;
  let carbsUnmeasuredItems = 0;
  let fatUnmeasuredItems = 0;
  let fiberUnmeasuredItems = 0;

  for (const item of items) {
    kcal += item.kcal;
    proteinG += item.proteinG;

    if (item.carbsState === 'unknown' || item.carbsG === null) carbsUnmeasuredItems += 1;
    else carbsG += item.carbsG;

    if (item.fatState === 'unknown' || item.fatG === null) fatUnmeasuredItems += 1;
    else fatG += item.fatG;

    if (item.fiberState === 'unknown' || item.fiberG === null) fiberUnmeasuredItems += 1;
    else fiberG += item.fiberG;
  }

  return {
    kcal: round2(kcal),
    proteinG: round2(proteinG),
    carbsG: round2(carbsG),
    fatG: round2(fatG),
    fiberG: round2(fiberG),
    carbsUnmeasuredItems,
    fatUnmeasuredItems,
    fiberUnmeasuredItems,
  };
}

/**
 * Grams for a stated quantity, given the food's household portions.
 *
 * Returns null rather than a default when the amount cannot be determined.
 * A silently invented 100 g is where a wrong week starts.
 */
export function gramsForPortion(
  portions: ReadonlyArray<{ label: string; grams: number }>,
  label: string,
  count = 1,
): number | null {
  const normalized = label.trim().toLowerCase();
  const match = portions.find((p) => p.label.trim().toLowerCase() === normalized);
  if (!match) return null;
  return round2(match.grams * count);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
