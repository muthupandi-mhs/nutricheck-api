import { z } from 'zod';
import { FoodSummary } from './food';

/**
 * The repeat strip. The most important flow in the app and the least
 * interesting to build: one tap, no sheet, no model call, ~2 seconds.
 *
 * Ranked by frequency x recency, filtered by time of day, and mixing single
 * foods with saved meals because both are one tap from the user's side.
 */
export const SuggestionKind = z.enum(['food', 'meal']);
export type SuggestionKind = z.infer<typeof SuggestionKind>;

export const Suggestion = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('food'),
    food: FoodSummary,
    /** The portion this user last logged, so the tap needs no portion picker. */
    grams: z.number().positive(),
    lastLoggedAt: z.string().datetime({ offset: true }),
    timesLogged: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('meal'),
    mealId: z.string().uuid(),
    name: z.string(),
    itemCount: z.number().int().positive(),
    kcal: z.number(),
    lastLoggedAt: z.string().datetime({ offset: true }).nullable(),
    timesLogged: z.number().int().nonnegative(),
  }),
]);
export type Suggestion = z.infer<typeof Suggestion>;

export const RecentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  /**
   * The client's local hour, 0-23. Breakfast foods should not lead the strip at
   * dinner. Optional: without it the time-of-day filter is simply not applied.
   */
  hour: z.coerce.number().int().min(0).max(23).optional(),
});
export type RecentsQuery = z.infer<typeof RecentsQuery>;

/**
 * A sentence that worked, for the composer's "say it again" strip.
 *
 * `kcal` is the total of the MOST RECENT entry this phrase produced, not an
 * average and not a stored number: "a bowl of rice and dal" is a different
 * size on different days, and the figure beside it should be the last one the
 * user actually accepted.
 *
 * `savedAs` is the name of the saved meal this phrase was promoted to, or null.
 * The strip shows the meal name with the sentence beneath it once it is set,
 * which is why it carries the name rather than the id.
 *
 * `useCount` is what makes the offer possible: a phrase becomes worth saving on
 * its second use (USER-FLOWS §5). The server counts; the client decides when to
 * ask. Promotion is never automatic — a meal appears because the user said yes.
 */
export const RecentPhrase = z.object({
  id: z.string().uuid(),
  phrase: z.string(),
  kcal: z.number(),
  savedAs: z.string().nullable(),
  useCount: z.number().int().positive(),
  lastUsedAt: z.string().datetime({ offset: true }),
});
export type RecentPhrase = z.infer<typeof RecentPhrase>;

export const PhrasesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export type PhrasesQuery = z.infer<typeof PhrasesQuery>;
