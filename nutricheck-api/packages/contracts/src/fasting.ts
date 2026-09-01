import { z } from 'zod';
import { Instant } from './common';

/**
 * Fasting.
 *
 * The app has always been able to say how long it had been since somebody last
 * logged something — a meal carries the time it was logged, so the gap is
 * already in the data, and Home has drawn a dial from it since the dials
 * existed. This is the other thing, and the difference is the whole design:
 *
 *   **A gap is measured. A fast is declared.**
 *
 * Nobody keeps a gap; they keep a fast. What makes the second worth a table is
 * that somebody said out loud when it started and how long they meant it to
 * run — a clock they can watch is then telling them about something they chose
 * rather than something that merely happened to them. So this is an explicit
 * session with a start, an end and a target: never inferred from the log, and
 * never closed by the server on somebody's behalf.
 *
 * The contrast with `weight.ts` is worth stating, because the two look alike
 * and are not. A weight is a measurement OF A DAY: it is filed under a
 * `LocalDate`, weighing twice on Tuesday corrects Tuesday, and the clock time
 * is noise. A fast is an INTERVAL ON THE CLOCK: its length is the entire point,
 * two of them can begin and end inside one calendar day, and one of them
 * routinely straddles midnight in whatever zone the phone is in. So every time
 * here is an `Instant`, never a local date, and nothing is keyed by day.
 */

/**
 * The protocols offered, and the only place they are written down.
 *
 * **A plan IS its target, and nothing else.** There is no plan column, no enum
 * and no migration when this list changes: "16:8" is simply what people call a
 * sixteen-hour fast, so the wire carries `targetHours: 16` and the label is
 * looked up here by both sides. Storing a slug beside the hours would be two
 * facts that can disagree, and the disagreement would be silent.
 *
 * The eating half of each name is what is left of the day, which is why the
 * pairs add to 24 — and why OMAD, the one that is not a ratio, is the only
 * label not derived from its figure. Twenty-three rather than a full
 * twenty-four, because a fast that leaves no room to eat is not a protocol, it
 * is a missing day.
 */
export const FASTING_PLANS = [
  { hours: 16, label: '16:8', detail: 'Eat within eight hours' },
  { hours: 18, label: '18:6', detail: 'Eat within six hours' },
  { hours: 20, label: '20:4', detail: 'A meal and a snack' },
  { hours: 23, label: 'OMAD', detail: 'One meal a day' },
] as const;

/** What the picker opens on for somebody who has never fasted before. */
export const FASTING_DEFAULT_TARGET_HOURS = 16;

/**
 * The bounds a target may take, deliberately wider than the presets.
 *
 * The presets are what the screen offers; these are what the API accepts. Four
 * hours because below that the word stops meaning anything — everybody fasts
 * for four hours, they call it lunch. Forty-eight because a multi-day fast is
 * a medical event and this is a food tracker, and declining to be the timer
 * for one is a position rather than an oversight.
 */
export const FASTING_TARGET_MIN_HOURS = 4;
export const FASTING_TARGET_MAX_HOURS = 48;

/**
 * How far back a start time may be moved.
 *
 * People remember to start the timer after they have already stopped eating,
 * so a start time that cannot be corrected is a timer that is wrong for
 * everybody honest about it. Bounded at three days because past that it is no
 * longer a correction — it is a fast invented after the fact, and this history
 * is worth more if it only holds fasts somebody actually sat through.
 */
export const FASTING_BACKDATE_MAX_HOURS = 72;

export const FastingTargetHours = z
  .number()
  .int()
  .min(FASTING_TARGET_MIN_HOURS)
  .max(FASTING_TARGET_MAX_HOURS);

/**
 * One fast, open or finished.
 *
 * A null `endedAt` is the whole of what "running" means. There is no status
 * field, because a status and a timestamp are two ways of saying one thing and
 * keeping both is an opportunity to say it inconsistently.
 */
export const Fast = z.object({
  id: z.string().uuid(),
  startedAt: Instant,
  /** Null while it is running. */
  endedAt: Instant.nullable(),
  targetHours: FastingTargetHours,
  /**
   * How long it actually ran, in hours. **Null while it is open, and that is
   * not an omission.**
   *
   * A running fast's length changes every second, and a number in a response
   * is a number as of the moment the response was built. Sending one would put
   * a figure on the screen that is already stale when it arrives and stays
   * wrong until something refetches — while the device holding the screen has
   * a clock that is right continuously. So the server sends `startedAt` and the
   * client subtracts, once a second, against `Date.now()` rather than by
   * incrementing a counter, which drifts across a backgrounded app.
   */
  hours: z.number().nullable(),
  /**
   * Whether it made its target. Null while open, for the reason `hours` is.
   *
   * Sent rather than left to the client to compare, because the comparison has
   * to be made against the SAME rounded figure the screen prints or the two
   * contradict each other: a fast of 15.997 hours displays as 16h and would
   * fail a raw `>= 16`, putting "16h" and "missed" on one row. One place
   * decides, and it is the place that did the rounding.
   */
  reachedTarget: z.boolean().nullable(),
});
export type Fast = z.infer<typeof Fast>;

/**
 * The record, all-time.
 *
 * All-time rather than over the returned window, because every figure here is
 * a personal best or an average, and both are questions about a habit rather
 * than about the last thirty rows. A "longest fast" that quietly forgets the
 * eighteen-hour one from March is a worse number than no number.
 */
export const FastingStats = z.object({
  /** Finished fasts. An open one is not counted until it closes. */
  completed: z.number().int().nonnegative(),
  /** How many of those reached their target. The denominator is `completed`. */
  reached: z.number().int().nonnegative(),
  longestHours: z.number(),
  averageHours: z.number(),
});
export type FastingStats = z.infer<typeof FastingStats>;

/**
 * Everything the fasting screen draws, in one response — and the return value
 * of every write, for the reason `WeightSeries` is: starting, ending or
 * deleting a fast moves the timer, the record and the history at once, and
 * returning only the row that changed would have the client either recompute
 * all of that or immediately GET what the server already had in hand.
 */
export const FastingSummary = z.object({
  /** The open fast, or null when nobody is fasting. */
  current: Fast.nullable(),
  /** Finished fasts, newest first, bounded by the query's `limit`. */
  recent: z.array(Fast),
  /** Null until one fast has finished; there is no average of nothing. */
  stats: FastingStats.nullable(),
  /**
   * What the start control should open on: the target of the most recent fast,
   * running or finished, else the default.
   *
   * This is the whole of the "which plan am I on" preference, and it is
   * deliberately stored nowhere. A protocol somebody sets once in a settings
   * screen and a protocol they pick each time they start are the same tap in
   * practice, and only the second one can never be out of date.
   */
  lastTargetHours: FastingTargetHours,
});
export type FastingSummary = z.infer<typeof FastingSummary>;

/**
 * Begin one.
 *
 * `startedAt` is optional and defaults to the moment the request lands. It is
 * accepted at all so that "I actually stopped eating at eight" is a correction
 * rather than a lie the timer has to live with — see
 * `FASTING_BACKDATE_MAX_HOURS` for how far back that reaches.
 */
export const StartFast = z.object({
  targetHours: FastingTargetHours,
  startedAt: Instant.optional(),
});
export type StartFast = z.infer<typeof StartFast>;

/**
 * Change the open fast without finishing it.
 *
 * Both fields are optional and at least one is required — the "at least one"
 * is checked in the service rather than by a `.refine`, so an empty body fails
 * as a stated rule with a field name on it rather than as a schema-level
 * message pointing nowhere.
 *
 * `targetHours` is here because extending mid-fast is the most common thing
 * anybody does with one of these: at fourteen hours, somebody feeling fine
 * pushes on to eighteen. Making them stop and restart would cost them the
 * fourteen hours they had already done, which is the one thing the screen
 * exists to keep.
 */
export const AdjustFast = z.object({
  targetHours: FastingTargetHours.optional(),
  startedAt: Instant.optional(),
});
export type AdjustFast = z.infer<typeof AdjustFast>;

/**
 * Finish it.
 *
 * `endedAt` defaults to now, and is accepted for the reason `startedAt` is:
 * the first bite happens before the phone comes out.
 */
export const EndFast = z.object({
  endedAt: Instant.optional(),
});
export type EndFast = z.infer<typeof EndFast>;

/**
 * How much history to return. Thirty by default — about a month for somebody
 * fasting daily, which is the span over which the list is still a list rather
 * than an archive.
 */
export const FastingHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
});
export type FastingHistoryQuery = z.infer<typeof FastingHistoryQuery>;
