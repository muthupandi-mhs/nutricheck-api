import { z } from 'zod';
import { FoodSummary } from './food';
import { LocalDate } from './common';
import { MealSlot } from './logs';

/**
 * The corpus-free path: a whole meal read out of one spoken sentence.
 *
 * "naa innaike rendu muttai and 5 dosai and chutney saapten" goes to the model
 * and comes back as three items with nutrition, without the corpus being
 * searched at all. That is the point of it — the corpus holds almost no Tamil
 * names, so a search-first flow dead-ends on the words people actually say.
 *
 * The cost of skipping the corpus is that these numbers are ESTIMATES. Every
 * row created here carries source 'ai' and every nutrient state is 'imputed',
 * which the client already renders with a `~`. Nothing about this shape should
 * let an estimate be mistaken for a measurement.
 */
export const AiMealItemDraft = z.object({
  /** The food row created for this item. Real, and usable in POST /v1/logs. */
  food: FoodSummary,
  /** The words this came from, so the user can check we heard them right. */
  spokenAs: z.string(),
  /** "5 dosai" — what they counted, in the unit they counted it in. */
  quantity: z.number().positive(),
  unit: z.string(),
  /** Total grams for the whole quantity. */
  grams: z.number().positive(),
  /**
   * Computed HERE from grams and the per-100g rates, never taken from the
   * model. Trusting a model for a rate it can only estimate is unavoidable;
   * trusting it for a multiplication we can do exactly is not.
   */
  kcal: z.number().nonnegative(),
  proteinG: z.number().nonnegative(),
  carbsG: z.number().nonnegative(),
  fatG: z.number().nonnegative(),
  fiberG: z.number().nonnegative(),
  /** Low when the dish was unfamiliar or the portion had to be assumed. */
  confidence: z.enum(['high', 'low']),
  /**
   * Which meal the sentence put this item in, or null when it did not say.
   *
   * Per item rather than per draft, because one sentence is routinely a whole
   * day — "kalaila lemon rice ... mathiyam briyani ... iravu 3 chappathi" is
   * four meals said at once, and a single slot on the draft would force the
   * client to file breakfast under dinner.
   *
   * Null is not a failure and not a default: it means the words carried no
   * time, and the client fills it from the clock. Guessing the slot from the
   * food would be inventing a fact about somebody's day.
   */
  meal: MealSlot.nullable(),
  /**
   * Which calendar day the sentence put this item on, or null when it did not
   * say.
   *
   * Per item rather than per draft, for the same reason `meal` is: one
   * sentence is routinely more than one day — "nethu poori saptutten, aprm
   * innaiku rendu idli" is yesterday and today said at once, and a single
   * date on the draft would force the client to file yesterday's poori under
   * today.
   *
   * Null is not a failure and not a default: it means the words carried no
   * date, and the client fills it from whichever day was selected when the
   * sheet was opened. Guessing a date from the food would be inventing a fact
   * about somebody's day.
   */
  date: LocalDate.nullable(),
});
export type AiMealItemDraft = z.infer<typeof AiMealItemDraft>;

export const AiMealDraft = z.object({
  draftId: z.string().uuid(),
  phrase: z.string(),
  /** One or two sentences, for the confirmation screen. */
  summary: z.string(),
  items: z.array(AiMealItemDraft),
  /** Words that sounded like food but produced no item. */
  unresolved: z.array(z.string()),
  /** Sum of the item totals. Computed here, for the same reason they are. */
  totals: z.object({
    kcal: z.number().nonnegative(),
    proteinG: z.number().nonnegative(),
    carbsG: z.number().nonnegative(),
    fatG: z.number().nonnegative(),
    fiberG: z.number().nonnegative(),
  }),
  /**
   * True for every item on this path. Present so a client cannot render one of
   * these drafts without having been told what it is.
   */
  estimated: z.literal(true),
});
export type AiMealDraft = z.infer<typeof AiMealDraft>;

export const AiMealRequest = z.object({
  phrase: z.string().trim().min(1).max(500),
  /**
   * The client's own local "today" — the anchor "today"/"yesterday" in the
   * phrase resolve against. The server has no reliable notion of the user's
   * local day otherwise; sent the same way `ChatRequest` already sends its
   * date for context.
   */
  today: LocalDate,
});
export type AiMealRequest = z.infer<typeof AiMealRequest>;
