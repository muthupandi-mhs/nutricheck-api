import { z } from 'zod';
import { LocalDate } from './common';

/**
 * Walking steps, per day. Simple aggregation only — no model reads or writes
 * this, unlike `ideas` or `insights`.
 */

/**
 * One day of the report. `logged` is not `steps > 0`: a day with nothing
 * recorded and a day somebody genuinely didn't walk are different facts, and
 * the chart draws them differently (see `WeekChart`'s same distinction for
 * calories).
 */
export const StepPoint = z.object({
  date: LocalDate,
  steps: z.number().int().nonnegative(),
  logged: z.boolean(),
});
export type StepPoint = z.infer<typeof StepPoint>;

/**
 * Record a day's steps. `date` defaults to the client's today — accepted at
 * all so a missed day can be backfilled, and it is the client's local date
 * for the same reason `LogWeight.date` is: the server's UTC "today" is wrong
 * for most of the world for part of every day.
 */
export const LogSteps = z.object({
  steps: z.number().int().min(0).max(100_000),
  date: LocalDate.optional(),
});
export type LogSteps = z.infer<typeof LogSteps>;

/** How many days back the report covers, ending today. */
export const StepsQuery = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
});
export type StepsQuery = z.infer<typeof StepsQuery>;

/**
 * Every day in the window, gap-filled, plus the aggregates over it.
 *
 * `averageSteps` is over LOGGED days only — the same convention `WeekSummary`
 * uses for calories, and for the same reason: dividing by the whole window
 * would punish someone for a day they never claimed to have tracked.
 */
export const StepsReport = z.object({
  from: LocalDate,
  to: LocalDate,
  days: z.array(StepPoint),
  totalSteps: z.number().int().nonnegative(),
  averageSteps: z.number().nonnegative(),
  loggedDays: z.number().int().nonnegative(),
  /** The best logged day in the window, or null when nothing was logged. */
  bestDay: StepPoint.nullable(),
  /**
   * A flat constant today (8000, matching the reference this screen is
   * modelled on), server-computed rather than a client default so a later
   * per-user goal costs no contract change.
   */
  dailyGoalSteps: z.number().int().positive(),
});
export type StepsReport = z.infer<typeof StepsReport>;

/**
 * One ranked row — a group's leaderboard and the admin-curated Stars list
 * are the same question ("who, and how many steps") asked of two different
 * audiences, so they share this shape rather than each declaring their own.
 */
export const StepsLeaderboardEntry = z.object({
  userId: z.string().uuid(),
  name: z.string().nullable(),
  steps: z.number().int().nonnegative(),
});
export type StepsLeaderboardEntry = z.infer<typeof StepsLeaderboardEntry>;
