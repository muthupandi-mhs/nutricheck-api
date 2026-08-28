import type { IdeaItem } from '../ai/ai.schemas';

/**
 * Does an idea's calorie figure agree with its own macros?
 *
 * This is the one check on this path that is arithmetic rather than judgement,
 * and it exists because the ideas step is the weakest-justified place in the
 * system where a model states nutrition. Everywhere else a figure is either
 * measured, derived from a formula, or anchored to one. Here it is recalled.
 *
 * Atwater: protein and carbohydrate carry 4 kcal per gram, fat 9. A model that
 * returns 250 kcal per 100 g alongside macros that sum to 90 has not rounded —
 * one of those two numbers is invented, and there is no way to tell which. So
 * the item is DROPPED rather than corrected. Correcting it would mean choosing
 * which half to believe, and quietly showing a figure nobody produced.
 *
 * A dropped idea costs the user one row on a list of suggestions. A wrong one
 * costs them a log entry they will never know was wrong.
 */

/**
 * How far apart the two figures may be before an item is refused.
 *
 * Wide on purpose, and it has to be. Fibre is counted inside total carbohydrate
 * but yields roughly 2 kcal per gram rather than 4, so a high-fibre food's
 * Atwater sum overshoots its true energy; published values also apply
 * food-specific factors rather than the flat 4/4/9 used here, and sugar
 * alcohols and unabsorbed fat pull the other way. A tight bound would refuse
 * correct answers about dal and chana — which are exactly the foods this tab
 * should be suggesting.
 *
 * A quarter catches what it is for: a figure that was never derived from the
 * macros beside it.
 */
const TOLERANCE = 0.25;

/**
 * Below this, the ratio is meaningless.
 *
 * A food at 12 kcal per 100 g — cucumber, black coffee, most greens — is real,
 * and its Atwater sum can be 6 or 20 without either being wrong; percentages of
 * a tiny denominator swing wildly on nothing. Anything under this floor passes
 * on the absolute difference instead, which for figures this small is the only
 * comparison that means anything.
 */
const MIN_KCAL_FOR_RATIO = 40;

/** kcal a gram of each macro carries. The one constant this whole file is about. */
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;

export interface AtwaterCheck {
  ok: boolean;
  /** What the macros add up to, per 100 g. */
  impliedKcal: number;
  /** What the model said, per 100 g. */
  statedKcal: number;
}

export function atwaterCheck(item: IdeaItem): AtwaterCheck {
  const { kcal, proteinG, carbsG, fatG } = item.per100g;

  const impliedKcal =
    proteinG * KCAL_PER_G.protein + carbsG * KCAL_PER_G.carbs + fatG * KCAL_PER_G.fat;

  const difference = Math.abs(kcal - impliedKcal);

  // Both figures small: compare absolutely. A 30 kcal food whose macros imply
  // 18 is fine; the same 12 kcal gap on a 500 kcal food would not be.
  const ok =
    Math.max(kcal, impliedKcal) < MIN_KCAL_FOR_RATIO
      ? difference <= MIN_KCAL_FOR_RATIO * TOLERANCE
      : difference / Math.max(kcal, impliedKcal) <= TOLERANCE;

  return { ok, impliedKcal: round(impliedKcal), statedKcal: kcal };
}

/**
 * Fibre cannot exceed carbohydrate, because it IS carbohydrate.
 *
 * Separate from the energy check because it fails differently: an item whose
 * fibre is above its carbs is not a mis-estimated food, it is a filled-in field
 * — and it would show a user "18 g of fibre" from something with 9 g of carbs
 * in it. Refused rather than clamped, on the same reasoning as above.
 */
export function fibreIsPossible(item: IdeaItem): boolean {
  return item.per100g.fiberG <= item.per100g.carbsG + 0.5;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
