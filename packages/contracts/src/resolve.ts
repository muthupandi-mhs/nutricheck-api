import { z } from 'zod';
import { FoodSummary } from './food';
import { Nutrients, Quantity } from './nutrition';

export const LogSource = z.enum(['text', 'voice', 'search', 'repeat', 'photo']);
export type LogSource = z.infer<typeof LogSource>;

/** The subset a resolve request may claim. `photo` exists in the enum but nothing produces it yet. */
export const ResolveSource = z.enum(['text', 'voice']);
export type ResolveSource = z.infer<typeof ResolveSource>;

export const ResolveRequest = z.object({
  phrase: z.string().trim().min(1).max(500),
  source: ResolveSource.default('text'),
  /** Local calendar day the entry belongs to; the client owns its own timezone. */
  loggedAt: z.string().datetime({ offset: true }).optional(),
});
export type ResolveRequest = z.infer<typeof ResolveRequest>;

/**
 * One line of the confirm sheet.
 *
 * `nutrients` is null exactly when `quantity.grams` is null — you cannot compute
 * a nutrient total for an amount nobody stated. The sheet renders an empty,
 * focused portion chip in that case rather than guessing (USER-FLOWS §7).
 */
export const ResolvedItem = z
  .object({
    itemId: z.string().uuid(),
    /** The span of the original phrase this item came from. */
    matchedText: z.string(),
    quantity: Quantity,
    food: FoodSummary.nullable(),
    /**
     * The eight rows the re-rank chose from. Shipped on every item, not just
     * low-confidence ones — it is cheap over the wire and makes the runner-up
     * expander instant instead of a second request.
     */
    candidates: z.array(FoodSummary).max(8),
    confidence: z.enum(['high', 'low']),
    nutrients: Nutrients.nullable(),
  })
  .refine((i) => (i.quantity.grams === null) === (i.nutrients === null), {
    message: 'nutrients must be null exactly when quantity.grams is null',
    path: ['nutrients'],
  })
  .refine((i) => i.food !== null || i.nutrients === null, {
    message: 'nutrients require a resolved food',
    path: ['nutrients'],
  });
export type ResolvedItem = z.infer<typeof ResolvedItem>;

export const UnresolvedItem = z.object({
  text: z.string(),
});
export type UnresolvedItem = z.infer<typeof UnresolvedItem>;

/**
 * The output of POST /v1/resolve. A draft is NOT a log — it is persisted to
 * Redis with a 1h TTL and written to Postgres only when the client commits it
 * through POST /v1/logs. This split is what makes "never auto-commit a parse"
 * a property of the API rather than client discipline.
 */
export const ResolveDraft = z.object({
  draftId: z.string().uuid(),
  /** Kept verbatim: the reproducible input for a replay, and the miss-log row. */
  phrase: z.string(),
  source: ResolveSource,
  items: z.array(ResolvedItem),
  unresolved: z.array(UnresolvedItem),
  aiRunId: z.string().uuid().nullable(),
  cached: z.boolean(),
});
export type ResolveDraft = z.infer<typeof ResolveDraft>;

/** SSE frames emitted by POST /v1/resolve. Discriminated on `event`. */
export const ResolveStreamEvent = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('parsed'),
    items: z.array(
      z.object({
        itemId: z.string().uuid(),
        matchedText: z.string(),
        quantity: Quantity,
      }),
    ),
    unresolved: z.array(UnresolvedItem),
  }),
  z.object({ event: z.literal('resolved'), draft: ResolveDraft }),
  z.object({
    event: z.literal('done'),
    draftId: z.string().uuid(),
    aiRunId: z.string().uuid().nullable(),
    latencyMs: z.number().int().nonnegative(),
  }),
  z.object({ event: z.literal('error'), problem: z.unknown() }),
]);
export type ResolveStreamEvent = z.infer<typeof ResolveStreamEvent>;
