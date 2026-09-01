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
 * The weekly review.
 *
 * One field, for the reason `InsightResult` has one: there is no numeric field
 * here, so a figure the model computed itself has nowhere to go. Every number
 * in `text` was handed over already calculated from the same week aggregate the
 * charts below it are drawn from.
 *
 * 700 rather than 400. Three or four sentences about seven days needs the room
 * a two-sentence note about one meal does not, and the prompt — not this cap —
 * is what keeps it from becoming an essay. The cap is the backstop for a model
 * that ignored it.
 */
export const WeekReviewResult = z.object({
  text: z.string().max(700),
});
export type WeekReviewResult = z.infer<typeof WeekReviewResult>;

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
  /**
   * Which meal the WORDS put this in, or null when they said nothing about it.
   *
   * Nullable rather than defaulted, and the difference matters: a default here
   * would be the model guessing a time of day from a food, which is a thing it
   * will happily do — idli reads as breakfast to a language model whatever
   * time it was eaten. Null means "the sentence does not say", and the client
   * fills it with the clock, which is the only source that actually knows.
   *
   * It exists because people narrate a whole day at once, at the end of it:
   * "kalaila lemon rice, mathiyam briyani, iravu 3 chappathi" is four meals in
   * one sentence, and logging that as one dinner is the app throwing away the
   * one thing the person took the trouble to tell it.
   */
  meal: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).nullable(),
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

/**
 * One turn of the assistant.
 *
 * Deliberately NOT the contract's `ChatReply`, though it is nearly the same
 * shape. This is what the model is asked to produce; that is what the client is
 * promised. Keeping them apart is what lets the service refuse a reply — a
 * fabricated number, an empty text — without the refusal being a contract
 * change, and it is the same separation `AiMealItem` has from
 * `AiMealItemDraft`.
 */
export const ChatResult = z.object({
  /** What to say. One or two sentences; the sheet is a panel, not a page. */
  text: z.string().min(1).max(600),
  /**
   * The user's own words, when the message was a meal rather than a question.
   *
   * Null is the common case and has to be easy for the model to choose:
   * questions outnumber meals in any conversation, and a required object here
   * would push it to invent a phrase to fill.
   */
  log: z
    .object({ phrase: z.string().min(1).max(500) })
    .nullable(),
});
export type ChatResult = z.infer<typeof ChatResult>;

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

/**
 * One suggested food, for a person with some of their day left.
 *
 * The third schema with numbers in it, and the one that had to argue hardest
 * for them. The meal path produces nutrition because the alternative is a dead
 * end on a sentence the corpus cannot serve; the targets path produces numbers
 * because it is handed the formula's answer and asked whether it should move.
 * This one runs because somebody opened a tab.
 *
 * It is shaped exactly like `AiMealItem` on purpose. The same three containments
 * apply and they are the reason this is tolerable at all — rates rather than
 * totals so the arithmetic stays with us, rows written source 'ai' and owned by
 * the person who saw them, every nutrient state 'imputed' so the app renders a
 * `~`. What it adds is `reason`, which is not decoration: a suggestion with no
 * argument attached cannot be disagreed with, and this list is only defensible
 * if the user can see why each row is on it.
 *
 * There is no field for a total anywhere in here, and no field for a food id.
 * A model on this path can be wrong about a rate; it cannot address a row in
 * the corpus, and it cannot state what somebody's serving adds up to.
 */
export const IdeaItem = z.object({
  /** Display name in the corpus's register: "Curd, plain", "Boiled egg". */
  name: z.string().min(1).max(120),
  /** Why this food for this gap, addressed to the user. */
  reason: z.string().min(1).max(240),
  /** The portion in ordinary words: "1 cup", "2 eggs", "1 bowl". */
  servingLabel: z.string().min(1).max(60),
  /** TOTAL grams for that serving, not per unit. Our arithmetic uses this. */
  grams: z.number().positive().max(2000),
  /**
   * Per 100 g, always. Asking for a rate rather than a total is what leaves
   * the multiplication with us — see `scaleIdea`.
   */
  per100g: z.object({
    kcal: z.number().nonnegative().max(900),
    proteinG: z.number().nonnegative().max(100),
    carbsG: z.number().nonnegative().max(100),
    fatG: z.number().nonnegative().max(100),
    fiberG: z.number().nonnegative().max(100),
  }),
  confidence: z.enum(['high', 'low']),
});
export type IdeaItem = z.infer<typeof IdeaItem>;

export const IdeasResult = z.object({
  /**
   * One or two sentences about where the day stands. The only place a figure
   * the model was GIVEN may be repeated, and no place at all for a new one.
   */
  note: z.string().max(400),
  /**
   * Capped at five. A longer list is not a better answer — it is the model
   * declining to choose, and every extra row is another set of invented rates
   * to pay for and check.
   */
  ideas: z.array(IdeaItem).max(5),
});
export type IdeasResult = z.infer<typeof IdeasResult>;
