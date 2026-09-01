import { z } from 'zod';
import { LocalDate } from './common';
import { MealSlot } from './logs';
import { WeightTrend } from './weight';

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

/**
 * The week in review — the note above the Insights charts.
 *
 * The same division of labour as `MealInsight` one scale up: everything below
 * is arithmetic done here over the week aggregate the charts already render,
 * and the model's only job is to say which two or three of these figures were
 * the week. `WeekReviewResult` has no numeric field, so there is nowhere for a
 * number the model worked out itself to appear.
 *
 * A week is the smallest window where "how is this going" has an answer. A day
 * is noise — one restaurant dinner moves it 900 kcal — and a month is too late
 * to change anything. That is why this exists at week scale and not either
 * side of it.
 */

/** One nutrient, averaged over the days that were actually logged. */
export const WeekAverage = z.object({
  /**
   * The mean over LOGGED days only, never over seven. Dividing by seven turns
   * "you forgot on Sunday" into "you undershot by 300 kcal" — a fact about the
   * app's completeness reported as one about the diet. Null when nothing in
   * the window was logged, which is not an average of zero.
   */
  average: z.number().nullable(),
  /** The target in effect on the last day of the window. Null when unset. */
  target: z.number().nullable(),
  /** average − target. Signed: negative is under. Null when either side is. */
  deltaFromTarget: z.number().nullable(),
  /** average / target as a percentage, rounded. Null when either side is. */
  percentOfTarget: z.number().nullable(),
});
export type WeekAverage = z.infer<typeof WeekAverage>;

/**
 * One day singled out of the week, with how far off it landed.
 *
 * `offByKcal` is signed — positive is over target — and it is the reason this
 * carries a figure at all rather than just a date. "Thursday was your furthest
 * day" invites the model to guess in which direction, and it would guess.
 */
export const WeekDayMark = z.object({
  date: LocalDate,
  kcal: z.number(),
  offByKcal: z.number(),
});
export type WeekDayMark = z.infer<typeof WeekDayMark>;

/**
 * How far from the calorie target a day may land and still count as on target.
 *
 * 0.15 — within 15%, either side. It is symmetric because a target is a target:
 * 3,000 kcal against 2,000 is not a better day than 1,000 is, and a rule that
 * rewarded one direction would make the figure meaningless to whichever half of
 * the users are eating more rather than less.
 *
 * **The mobile history calendar paints with this same number** (see
 * `adherenceOf` and `ON_TARGET` there). The client cannot import this package
 * yet, so the two are kept equal by hand and by a test on each side. If this
 * moves, that moves — otherwise the review calls Tuesday on target while the
 * calendar shows it amber, and nothing on either screen explains the other.
 */
export const ON_TARGET_TOLERANCE = 0.15;

export const WeekFacts = z.object({
  from: LocalDate,
  to: LocalDate,
  /** Days in the window with at least one entry. 0 to 7. */
  loggedDays: z.number().int().min(0).max(7),
  /** Uncapped, counted back from `to`. Zero when `to` itself has no entry. */
  streakDays: z.number().int().nonnegative(),
  /**
   * Logged days that landed within `ON_TARGET_TOLERANCE` of the calorie target.
   *
   * Symmetric — over costs exactly what under costs. The same rule the history
   * calendar paints with, and it has to stay the same rule: a review that
   * called Tuesday on target while the calendar showed it amber would leave
   * the user with two screens and no way to tell which one to believe.
   */
  onTargetDays: z.number().int().min(0).max(7),
  kcal: WeekAverage,
  proteinG: WeekAverage,
  carbsG: WeekAverage,
  fatG: WeekAverage,
  fiberG: WeekAverage,
  /** The logged day nearest its calorie target. Null when nothing was logged. */
  closestDay: WeekDayMark.nullable(),
  /**
   * The logged day furthest from it. Null when nothing was logged, and equal to
   * `closestDay` when exactly one day was — which is honest rather than tidy.
   */
  furthestDay: WeekDayMark.nullable(),
  /**
   * The fitted rate of weight change as of the end of this window, when there
   * are two readings to draw a line through. Null otherwise — and null is
   * common, because weighing in is optional.
   *
   * Included because it is the one thing a week can answer that a day cannot:
   * whether any of the above is working.
   *
   * **The fit is over a longer span than the week it appears on**, ending on
   * this window's last day. Seven days holds one or two weigh-ins for most
   * people, and a least-squares line through two points is just those two
   * points — the noise the fit exists to absorb would be the whole of the
   * answer. So this is a RATE as of the end of the week, never a claim about
   * what happened during it, and the prompt states it that way.
   */
  weight: WeightTrend.nullable(),
  /**
   * The seven days before this window, for the only comparison a weekly report
   * is really for. Two figures and no more: how many days were logged, and what
   * they averaged. Anything richer is a second report nobody asked for.
   */
  previous: z.object({
    loggedDays: z.number().int().min(0).max(7),
    kcalAverage: z.number().nullable(),
  }),
});
export type WeekFacts = z.infer<typeof WeekFacts>;

export const WeekReview = z.object({
  facts: WeekFacts,
  /**
   * Three or four sentences. EMPTY when the model was unavailable, refused, or
   * the week has nothing logged — the client renders the figures and no prose,
   * exactly as a meal card does. An empty string is "no review", never a
   * failure to retry.
   */
  text: z.string(),
  /** Served from cache. A past week never changes; the current one does. */
  cached: z.boolean(),
  model: z.string().nullable(),
});
export type WeekReview = z.infer<typeof WeekReview>;

export const WeekReviewQuery = z.object({
  /** The LAST day of the window, inclusive — the same anchor `WeekQuery` takes. */
  date: LocalDate,
  /** IANA zone; the day boundaries are the user's, exactly as for a day view. */
  tz: z.string().min(1).default('UTC'),
});
export type WeekReviewQuery = z.infer<typeof WeekReviewQuery>;
