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

/**
 * Suggested daily targets.
 *
 * The second schema in the system with numbers in it, and the only one whose
 * numbers are about the next few months rather than one plate. What keeps that
 * honest is not this schema — a bound in Zod only rejects the absurd — it is
 * `clampTargets` on the way out, which holds the figures inside the same limits
 * the derived goal obeys and never lets calories fall under resting burn.
 *
 * These bounds are the outer physiological edges, deliberately wider than the
 * clamp. A value between the two is a model that misjudged and gets corrected;
 * a value outside these is a model that malfunctioned, and that should fail
 * loudly as a malformed response rather than being quietly pulled into range.
 */
export const TargetsResult = z.object({
  kcal: z.number().int().min(800).max(8000),
  proteinG: z.number().int().min(10).max(500),
  fiberG: z.number().int().min(5).max(120),
  /** Addressed to the user, and the only place a figure may be repeated. */
  reasoning: z.string().max(400),
});
export type TargetsResult = z.infer<typeof TargetsResult>;

/**
 * What an unmatched name might be, in words the corpus could plausibly hold.
 *
 * This is the one AI step whose whole job is translation, and the schema is
 * shaped so it cannot become anything more. There is no food id here, so a
 * suggestion cannot address a row directly; there is no nutrient field, so a
 * guess about a food is never a guess about a number. The names go back through
 * the ordinary corpus search, and a name for something we do not stock simply
 * matches nothing — the model can fail to find a food, never invent one.
 *
 * `names` are English search terms, because that is what the corpus is written
 * in: USDA calls it "Balsam-pear (bitter gourd), pods, raw", so proposing
 * "bitter gourd" finds it and proposing "pavakkai" does not. `script` carries
 * the original back so the alias, if the user confirms it, is stored in the
 * form they actually typed.
 *
 * `isFood` exists because the parse step is not perfect: it will occasionally
 * hand over a quantity word, a filler, or a person's name. Saying so plainly is
 * cheaper than three suggestions for a word that was never a food.
 */
/**
 * A whole meal read straight from what somebody said, without the corpus.
 *
 * This is a deliberate exception to the rule the rest of this file enforces,
 * and it should be read as one. Everywhere else the model is denied a numeric
 * field so it cannot state a figure it worked out itself; here it supplies the
 * figures, because the alternative for "rendu muttai and 5 dosai and chutney"
 * is a dead end when any one of those words is missing from the corpus.
 *
 * Three things keep the exception bounded:
 *
 * 1. RATES, NOT TOTALS. The model gives per-100g values and a gram weight; the
 *    multiplication happens in our code. A model that multiplies 5 x 168 and
 *    gets it wrong is an ordinary failure, and there is no reason to accept it
 *    when arithmetic is the one part we can do perfectly.
 * 2. Every resulting row is written as source 'ai' and owned by the user who
 *    said it, so "which numbers did a model make up" stays a one-line query and
 *    nobody else's search is affected.
 * 3. Every nutrient state is 'imputed', which the app already renders with a
 *    `~`. The user is told these are estimates in the same way the curated
 *    Indian dishes tell them.
 */
export const AiMealItem = z.object({
  /** Display name, in the corpus's own register: "Dosai, plain". */
  name: z.string().min(1).max(120),
  /** The words this came from, so the draft can show what was heard. */
  spokenAs: z.string().max(120),
  /** How many of `unit`. 5 for "5 dosai". */
  quantity: z.number().positive().max(100),
  /** "dosai", "egg", "cup", "g" — whatever the person actually counted in. */
  unit: z.string().min(1).max(40),
  /** TOTAL grams for the whole quantity, not per unit. Our arithmetic uses this. */
  grams: z.number().positive().max(5000),
  /**
   * Per 100 g, always — never per portion. Asking for a rate rather than a
   * total is what leaves the multiplication with us.
   */
  per100g: z.object({
    kcal: z.number().nonnegative().max(900),
    proteinG: z.number().nonnegative().max(100),
    carbsG: z.number().nonnegative().max(100),
    fatG: z.number().nonnegative().max(100),
    fiberG: z.number().nonnegative().max(100),
  }),
  /** Low when the dish is unfamiliar or the portion was never stated. */
  confidence: z.enum(['high', 'low']),
});
export type AiMealItem = z.infer<typeof AiMealItem>;

export const AiMealResult = z.object({
  /** One or two sentences describing the meal, for the confirmation screen. */
  summary: z.string().max(400),
  items: z.array(AiMealItem).max(12),
  /** Words that were audibly food but could not be turned into an item. */
  unresolved: z.array(z.string().max(120)).max(6),
});
export type AiMealResult = z.infer<typeof AiMealResult>;

export const IdentifyResult = z.object({
  isFood: z.boolean(),
  /** English search terms, most likely first. Empty when isFood is false. */
  names: z.array(z.string().max(80)).max(5),
  /** The input as the model reads it, in its own script. Empty if unclear. */
  script: z.string().max(80),
  /** Rough, and used only to decide whether to show the user a suggestion. */
  confidence: z.enum(['high', 'low']),
});
export type IdentifyResult = z.infer<typeof IdentifyResult>;
