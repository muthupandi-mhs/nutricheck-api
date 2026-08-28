import { z } from 'zod';
import { LocalDate } from './common';
import { FoodSummary } from './food';

/**
 * Food ideas: what to eat next, for this person, with this much of the day left.
 *
 * The third place in the system where a model produces nutrition figures, after
 * `/v1/ai-meal` and `/v1/me/goals/suggest`, and the only one nobody asked for by
 * typing a sentence — it runs because a tab was opened. That makes the framing
 * matter more here than anywhere else, not less.
 *
 * What keeps it bounded is the same discipline the meal path uses, plus one
 * check it does not have:
 *
 *   - the model supplies per-100g RATES and a gram weight; every total below is
 *     a product of those two, computed on the server
 *   - every row created here is written source 'ai', owned by the person who
 *     opened the tab, with every nutrient state 'imputed' — so the app renders
 *     them with a `~` and nobody else's search sees them
 *   - an item whose stated calories disagree with its own macros by more than a
 *     quarter is DROPPED, not corrected. Atwater is arithmetic we can do; a
 *     model that fails it has not made a small error, it has made one up
 *
 * The ideas are things to look at. Tapping one opens the ordinary portion
 * screen, which is where a log is actually written — nothing here commits.
 */
export const FoodIdea = z.object({
  /** The food row created for this idea. Real, and usable in POST /v1/logs. */
  food: FoodSummary,
  /**
   * Why this, for this person, now. One sentence, addressed to the user.
   *
   * Required rather than optional: a suggestion with no argument attached is
   * indistinguishable from a list the app shuffled, and the whole claim of this
   * tab is that the list was built from THEIR remaining targets.
   */
  reason: z.string(),
  /** The portion the figures below describe. */
  grams: z.number().positive(),
  /** How a person would say that portion — "1 bowl", "2 eggs", "150 g". */
  servingLabel: z.string(),
  /**
   * Computed on the server from the per-100g rates and `grams`, never taken
   * from the model. Trusting a model for a rate it can only estimate is the
   * unavoidable part; trusting it for a multiplication is not.
   */
  kcal: z.number().nonnegative(),
  proteinG: z.number().nonnegative(),
  carbsG: z.number().nonnegative(),
  fatG: z.number().nonnegative(),
  fiberG: z.number().nonnegative(),
  /** Low when the dish is unusual or the portion had to be assumed. */
  confidence: z.enum(['high', 'low']),
});
export type FoodIdea = z.infer<typeof FoodIdea>;

/**
 * What is left of the day's targets, per nutrient.
 *
 * Null when the target itself is not set, and NEGATIVE when the target has been
 * passed — reported either way, never clamped to zero. Somebody 300 kcal over
 * is asking a different question from somebody exactly on target, and the tab
 * answers it differently.
 */
export const RemainingTargets = z.object({
  kcal: z.number().nullable(),
  proteinG: z.number().nullable(),
  carbsG: z.number().nullable(),
  fatG: z.number().nullable(),
  fiberG: z.number().nullable(),
});
export type RemainingTargets = z.infer<typeof RemainingTargets>;

export const FoodIdeas = z.object({
  date: LocalDate,
  /**
   * The gap these ideas were built for, carried back so the screen can show it.
   *
   * Without it the list is an assertion. With it the user can see the same
   * arithmetic the model was handed, and disagree with the suggestion on the
   * evidence rather than on feel.
   */
  remaining: RemainingTargets,
  ideas: z.array(FoodIdea),
  /**
   * A sentence about the day so far. EMPTY whenever the model was unavailable
   * or refused — the screen renders `remaining` and says less, exactly as a
   * meal card does with a missing note. Never an error to retry.
   */
  note: z.string(),
  /**
   * True for every idea on this path. Present so a client cannot render one
   * without having been handed the fact that its numbers are estimates.
   */
  estimated: z.literal(true),
  /** Served from cache. Ideas are stable until the day's totals move. */
  cached: z.boolean(),
});
export type FoodIdeas = z.infer<typeof FoodIdeas>;

export const FoodIdeasQuery = z.object({
  date: LocalDate,
  /** IANA zone; the day boundary is the user's, exactly as for a day view. */
  tz: z.string().min(1).default('UTC'),
});
export type FoodIdeasQuery = z.infer<typeof FoodIdeasQuery>;
