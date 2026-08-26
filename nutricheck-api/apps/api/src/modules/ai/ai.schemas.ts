import { QuantityType } from '@nutricheck/contracts';
import { z } from 'zod';

/**
 * Structured-output schemas for the two model calls.
 *
 * These are the guardrails, not documentation. The parse schema has no field in
 * which a nutrient value could be returned, and the re-rank schema restricts
 * `foodId` to an enum built per request from the ids Postgres just returned —
 * so an invented food is not merely discouraged, it cannot be expressed.
 */

export const ParsedItem = z.object({
  /** The span of the original phrase, verbatim. Shown when the user corrects it. */
  matchedText: z.string(),
  /** The food alone, in the user's own words. */
  foodPhrase: z.string(),
  quantityType: QuantityType,
  /** Null exactly when quantityType is none_given. */
  quantityValue: z.number().nullable(),
  quantityUnit: z.string().nullable(),
});
export type ParsedItem = z.infer<typeof ParsedItem>;

export const ParseResult = z.object({
  items: z.array(ParsedItem),
  /** Words that mention food but could not be turned into an item. */
  unresolved: z.array(z.string()),
});
export type ParseResult = z.infer<typeof ParseResult>;

/**
 * Built per request. `candidateIds` are the eight ids the search returned for
 * this item, so the enum makes an off-list answer unrepresentable rather than
 * merely instructed against.
 */
export function rerankSchemaFor(candidateIds: readonly string[]) {
  const ids = candidateIds.length > 0 ? candidateIds : ['__none__'];
  return z.object({
    picks: z.array(
      z.object({
        itemIndex: z.number().int().nonnegative(),
        foodId: z.enum(ids as [string, ...string[]]),
        confidence: z.enum(['high', 'low']),
      }),
    ),
  });
}

export type RerankResult = {
  picks: Array<{ itemIndex: number; foodId: string; confidence: 'high' | 'low' }>;
};

/**
 * The per-meal note.
 *
 * One field, and that is the safety property. There is no numeric field in this
 * schema, so the model has nowhere to put a figure it worked out for itself —
 * exactly the reasoning that keeps nutrient values out of `ParsedItem`. Every
 * number that appears does so inside `text`, copied from the facts it was
 * given, and the prompt is explicit that inventing one is not allowed.
 *
 * The cap is a cost and a UI bound at once: two sentences under a meal card,
 * not an essay nobody reads.
 */
export const InsightResult = z.object({
  text: z.string().max(400),
});
export type InsightResult = z.infer<typeof InsightResult>;
