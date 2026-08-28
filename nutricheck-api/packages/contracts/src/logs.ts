import { z } from 'zod';
import { Instant, LocalDate } from './common';
import { FoodSummary } from './food';
import { Nutrients, QuantitySource, QuantityType } from './nutrition';
import { LogSource } from './resolve';

export const MealSlot = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
export type MealSlot = z.infer<typeof MealSlot>;

/**
 * What the client sends per item. Note what is NOT here: nutrient values.
 * The server recomputes kcal/protein/fiber from food_nutrients at commit and
 * freezes the result. The client's copy exists for optimistic rendering only.
 */
export const CommitItem = z.object({
  foodId: z.string().uuid(),
  grams: z.number().positive().max(10_000),
  quantityType: QuantityType,
  quantitySource: QuantitySource,
  /** Present when the user corrected a personal unit — writes back to user_portions. */
  learnedUnitLabel: z.string().trim().min(1).max(40).nullable().default(null),
});
export type CommitItem = z.infer<typeof CommitItem>;

/**
 * `clientId` is generated on-device at the moment the user taps commit, before
 * any network call, and stored with the queued entry. UNIQUE (user_id, client_id)
 * makes a replayed offline queue idempotent: a retry returns the original entry
 * rather than creating a second breakfast.
 */
export const CommitLogEntry = z.object({
  clientId: z.string().uuid(),
  loggedAt: Instant,
  meal: MealSlot,
  source: LogSource,
  /** The phrase that produced this entry, if any. Kept for replay and the miss log. */
  phrase: z.string().max(500).nullable().default(null),
  draftId: z.string().uuid().nullable().default(null),
  items: z.array(CommitItem).min(1).max(25),
});
export type CommitLogEntry = z.infer<typeof CommitLogEntry>;

export const CommitLogBatch = z.object({
  entries: z.array(CommitLogEntry).min(1).max(50),
});
export type CommitLogBatch = z.infer<typeof CommitLogBatch>;

export const LogItem = z.object({
  id: z.string().uuid(),
  food: FoodSummary,
  grams: z.number().positive(),
  quantityType: QuantityType,
  quantitySource: QuantitySource,
  /** Frozen at commit — never recomputed on read, so history cannot drift. */
  nutrients: Nutrients,
});
export type LogItem = z.infer<typeof LogItem>;

export const LogEntry = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  loggedAt: Instant,
  meal: MealSlot,
  source: LogSource,
  phrase: z.string().nullable(),
  items: z.array(LogItem),
});
export type LogEntry = z.infer<typeof LogEntry>;

/**
 * Per-element result for a drained offline queue. One bad entry must not fail
 * the other eleven, so a batch always returns 200 with a mixed body.
 */
export const BatchCommitResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('created'), clientId: z.string().uuid(), entry: LogEntry }),
  z.object({ status: z.literal('duplicate'), clientId: z.string().uuid(), entry: LogEntry }),
  z.object({ status: z.literal('failed'), clientId: z.string().uuid(), problem: z.unknown() }),
]);
export type BatchCommitResult = z.infer<typeof BatchCommitResult>;

export const DayQuery = z.object({
  date: LocalDate,
  /** IANA zone; the day boundary is the user's, not UTC's. */
  tz: z.string().min(1).default('UTC'),
});
export type DayQuery = z.infer<typeof DayQuery>;

/**
 * The day view. `fiberUnmeasuredItems` is why the ring can honestly read
 * "8 g of 28 g, 2 items unmeasured" instead of quietly counting unknowns as zero.
 */
export const DaySummary = z.object({
  date: LocalDate,
  totals: z.object({
    kcal: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
    fiberG: z.number(),
    /**
     * One count per nutrient that can go unknown, not a shared one. An item
     * missing fibre is usually not the item missing carbs, and a single number
     * could not say which total to distrust.
     */
    carbsUnmeasuredItems: z.number().int().nonnegative(),
    fatUnmeasuredItems: z.number().int().nonnegative(),
    fiberUnmeasuredItems: z.number().int().nonnegative(),
  }),
  goal: z.object({
    kcal: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
    fiberG: z.number(),
  }),
  entries: z.array(LogEntry),
});
export type DaySummary = z.infer<typeof DaySummary>;

/**
 * Edit a whole entry. Items are REPLACED wholesale: this is the confirm sheet
 * rewriting a meal, where items may be added, removed or swapped. To change
 * ONE committed portion, use `UpdateLogItem` — it keeps the correction.
 *
 * Nutrients are recomputed and re-frozen from the corpus, exactly as on commit.
 */
export const UpdateLogEntry = z.object({
  meal: MealSlot.optional(),
  loggedAt: Instant.optional(),
  items: z.array(CommitItem).min(1).max(25).optional(),
});
export type UpdateLogEntry = z.infer<typeof UpdateLogEntry>;

/**
 * Change ONE item's portion, addressed by its own id.
 *
 * Distinct from `UpdateLogEntry` because the two edits are different acts. The
 * confirm sheet rewrites a whole meal; dragging one portion on the day view
 * changes one number and must not touch the others — a read-modify-write of
 * every item to move one would silently clobber a concurrent edit.
 *
 * `log_items.id` is server-issued, stable, and already on the wire in every
 * `LogEntry`, so the identity this needs is one the client demonstrably has.
 * (The "no stable per-item identity" note on `UpdateLogEntry` is about a
 * RE-PARSE, which mints new items; a committed entry's items keep their ids.)
 *
 * `learnedUnitLabel` is the point of the route. A portion correction is the
 * single most valuable training signal the product gets, and routing this edit
 * through the wholesale PATCH would throw it away.
 */
export const UpdateLogItem = z.object({
  grams: z.number().positive().max(10_000),
  /** Present when the correction names a personal unit — writes user_portions. */
  learnedUnitLabel: z.string().trim().min(1).max(40).nullable().default(null),
});
export type UpdateLogItem = z.infer<typeof UpdateLogItem>;

export const WeekQuery = z.object({
  /** The LAST day of the window, inclusive. The week is this date and the six before it. */
  date: LocalDate,
  /** IANA zone; the day boundaries are the user's, exactly as for a day view. */
  tz: z.string().min(1).default('UTC'),
});
export type WeekQuery = z.infer<typeof WeekQuery>;

/**
 * One bar of the week chart. `logged` is not `kcal > 0`: a day with an entry
 * that happens to total nothing is still a day the user showed up, and the
 * streak and the averages both turn on that distinction.
 */
export const DayPoint = z.object({
  date: LocalDate,
  kcal: z.number(),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
  fiberG: z.number(),
  logged: z.boolean(),
});
export type DayPoint = z.infer<typeof DayPoint>;

/**
 * Seven days ending on the requested date.
 *
 * `averages` are over the LOGGED days only. Dividing by seven would quietly
 * punish someone for a day they never claimed to have tracked, and turn "I ate
 * well on the four days I logged" into a number that says the opposite.
 *
 * `streakDays` counts back from `to` and is NOT capped by the window — a
 * fourteen-day streak reports fourteen. It is zero when `to` itself has no
 * entry, which is what "counting back from today" means literally.
 */
export const WeekSummary = z.object({
  from: LocalDate,
  to: LocalDate,
  days: z.array(DayPoint).length(7),
  goal: z.object({
    kcal: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
    fiberG: z.number(),
  }),
  averages: z.object({
    kcal: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
    fiberG: z.number(),
  }),
  streakDays: z.number().int().nonnegative(),
});
export type WeekSummary = z.infer<typeof WeekSummary>;

/**
 * A calendar month, for the history view behind the Today masthead.
 *
 * `date` is any day inside the month wanted — the server snaps to the first and
 * last of that month itself. Passing an anchor rather than a `2026-08` string
 * keeps one date format on the wire and means the client can hand over
 * whichever day it is already holding without formatting anything.
 */
export const MonthQuery = z.object({
  /** Any day in the month. The window is that whole calendar month. */
  date: LocalDate,
  /** IANA zone; the day boundaries are the user's, exactly as for a day view. */
  tz: z.string().min(1).default('UTC'),
});
export type MonthQuery = z.infer<typeof MonthQuery>;

/**
 * Every day of one calendar month, logged or not.
 *
 * The same `DayPoint` the week chart uses, and deliberately so: a calendar cell
 * and a chart bar are answering the same question at different resolutions, and
 * a second shape for it would be a second place for `logged` to mean something
 * slightly different.
 *
 * Length is not fixed — months are 28 to 31 days — but every day in the range
 * is present whether or not it has entries, so a client can index the grid by
 * position without checking for holes.
 *
 * **`goal` is the one in effect on the LAST day of the month**, not per day.
 * That is a real limitation and it is the same one `WeekSummary` carries: a
 * user who changed their target mid-month has the back half's colours computed
 * against the front half's goal. Resolving it per day means a goal lookup per
 * cell, and it is not worth that until somebody actually changes targets often
 * enough to notice.
 */
export const MonthSummary = z.object({
  from: LocalDate,
  to: LocalDate,
  days: z.array(DayPoint),
  goal: z.object({
    kcal: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
    fiberG: z.number(),
  }),
  /** Days in the month with at least one entry. */
  loggedDays: z.number().int().nonnegative(),
});
export type MonthSummary = z.infer<typeof MonthSummary>;
