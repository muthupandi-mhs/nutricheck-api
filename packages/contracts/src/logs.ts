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
    fiberG: z.number(),
    fiberUnmeasuredItems: z.number().int().nonnegative(),
  }),
  goal: z.object({
    kcal: z.number(),
    proteinG: z.number(),
    fiberG: z.number(),
  }),
  entries: z.array(LogEntry),
});
export type DaySummary = z.infer<typeof DaySummary>;
