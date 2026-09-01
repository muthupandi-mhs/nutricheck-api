import { z } from 'zod';
import { LocalDate } from './common';

/**
 * Body weight over time.
 *
 * The profile has always held exactly one weight, because that is all the goal
 * math needs: Mifflin–St Jeor takes a number, not a history. This is the other
 * half — what the user needs to see, which is whether the number is moving and
 * how fast. The two are the same figure at different resolutions, and they are
 * kept in step at both doors rather than one deriving the other (see
 * `weight_logs` in the schema for why).
 */

/** One reading. `date` is the LOCAL day it was taken, never a UTC instant. */
export const WeightPoint = z.object({
  date: LocalDate,
  weightKg: z.number(),
});
export type WeightPoint = z.infer<typeof WeightPoint>;

/**
 * The movement, measured rather than assumed.
 *
 * `kgPerWeek` is a least-squares slope over the window, not `(last - first)`
 * divided by the span. Weight is noisy at the scale people weigh themselves —
 * a litre of water is a kilo — and two endpoints let a single dehydrated
 * Tuesday claim a trend that the other twenty readings contradict. The fit
 * uses every point, so one bad morning moves it a little instead of deciding
 * it.
 *
 * Signed, and never normalized against the objective: negative is losing. A
 * "progress" figure that flips sign depending on what somebody is trying to do
 * is a figure nobody can read at a glance.
 */
export const WeightTrend = z.object({
  kgPerWeek: z.number(),
  /** Last reading minus first, over the window. Plain subtraction, unfitted. */
  deltaKg: z.number(),
  /** Days between the first and last reading — the span the fit is honest over. */
  spanDays: z.number().int().nonnegative(),
  /**
   * What the profile SAID the rate would be, as a signed kg/week, so the screen
   * can put intent next to outcome. Null when maintaining, because there is no
   * intended rate to miss.
   *
   * Carried here rather than derived on the client from `objective` and
   * `rateKgPerWeek`: the sign convention belongs with the figure it applies to,
   * and a client that reconstructs it is a second place to get it backwards.
   */
  intendedKgPerWeek: z.number().nullable(),
});
export type WeightTrend = z.infer<typeof WeightTrend>;

/**
 * Everything the weight screen draws, in one response.
 *
 * `current` and `start` are pulled out of `points` rather than left for the
 * client to find, because "the first one in the window" and "the first one ever
 * recorded" are different questions and the second is the one worth showing.
 */
export const WeightSeries = z.object({
  /** Oldest first, one per day, only days that were actually logged. */
  points: z.array(WeightPoint),
  /**
   * The latest reading there is — which may predate the window, so a user who
   * has not weighed themselves in three months still sees their weight rather
   * than a dash.
   */
  current: WeightPoint.nullable(),
  /** The earliest reading ever recorded, window or not. The baseline. */
  start: WeightPoint.nullable(),
  /** Null until there are two readings on different days to draw a line between. */
  trend: WeightTrend.nullable(),
});
export type WeightSeries = z.infer<typeof WeightSeries>;

/**
 * Record a weight.
 *
 * Bounded identically to `UserProfile.weightKg` — same number, same table of
 * record eventually, so a value this accepts and the profile rejects would be a
 * write that half-lands.
 *
 * `date` defaults to the client's today. It is accepted at all so somebody can
 * enter Saturday's weigh-in on Sunday, and it is the client's local date
 * because the server's idea of today is in UTC and is wrong for most of the
 * planet for part of every day.
 */
export const LogWeight = z.object({
  weightKg: z.number().min(25).max(400),
  date: LocalDate.optional(),
});
export type LogWeight = z.infer<typeof LogWeight>;

/**
 * How much history to draw. 90 days by default — long enough for a trend to be
 * visible at the rates people actually change weight, short enough that the
 * chart is not a flat line with a wiggle at one end.
 */
export const WeightSeriesQuery = z.object({
  days: z.coerce.number().int().min(7).max(730).default(90),
});
export type WeightSeriesQuery = z.infer<typeof WeightSeriesQuery>;
