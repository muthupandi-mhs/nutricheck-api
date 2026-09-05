import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  normalizeSearchText,
  type AiMealDraft,
  type AiMealItemDraft,
} from '@nutricheck/contracts';
import { schema, type Database } from '@nutricheck/database';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { AiRunsService } from '../ai/ai-runs.service';
import { AiService } from '../ai/ai.service';
import type { AiMealItem } from '../ai/ai.schemas';
import { FoodsService } from '../foods/foods.service';
import { assignMealDates } from './meal-dates';
import { assignMealTimes, SEQUENCE_WORDS, TIME_WORDS } from './meal-times';
import { QuotaService } from '../quota/quota.service';

/**
 * Reading a meal straight from a sentence, with the corpus switched off.
 *
 * The rest of the system resolves against measured rows and refuses to let the
 * model near a number. This path does the opposite, deliberately: the corpus
 * carries almost no Tamil names, so "rendu muttai and 5 dosai and chutney"
 * dead-ends on a search-first flow, and a dead end is worse for the user than
 * an estimate they can see is an estimate.
 *
 * Everything here exists to keep that trade visible rather than silent:
 *
 *   - the model supplies RATES; every total below is multiplied here
 *   - rows are written source 'ai', owned by the speaker, states 'imputed'
 *   - the draft carries estimated: true, so no client can render one without
 *     having been handed that fact
 */
@Injectable()
export class AiMealService {
  private readonly logger = new Logger(AiMealService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ai: AiService,
    private readonly aiRuns: AiRunsService,
    private readonly foods: FoodsService,
    private readonly quota: QuotaService,
  ) {}

  get isConfigured(): boolean {
    return this.ai.isConfigured;
  }

  async interpret(userId: string, phrase: string, today: string): Promise<AiMealDraft> {
    // QuotaGuard has already refused an exhausted user; this books the unit.
    // A call that then fails is refunded, on the resolver's reasoning: a user
    // should not pay a daily unit for our provider having a bad minute.
    await this.quota.consume(userId);

    let result;
    try {
      result = await this.ai.interpretMeal(phrase);
    } catch (error) {
      await this.quota.refund(userId).catch(() => undefined);
      throw error;
    }

    await this.aiRuns.recordCall(userId, 'meal', hashOf(phrase), result);

    // The sentence gets the last word on WHEN, before anything is written.
    //
    // The model is asked for it and usually answers, but the failure when it
    // does not is silent and total: every slot comes back null, the client
    // falls back to the clock, and a day narrated at midday is filed as one
    // enormous lunch. Reading the time words out of the sentence is
    // deterministic, uses only what the person said, and cannot be talked out
    // of it by a model having an off minute.
    const timed = assignMealTimes(phrase, result.value.items);

    // Same reasoning as the words above, for WHICH DAY: deterministic,
    // anchored to the caller's own "today" rather than the server's clock,
    // which knows nothing about where the user is.
    const dated = assignMealDates(phrase, timed, today);

    const items: AiMealItemDraft[] = [];
    for (const item of dated) {
      items.push(await this.materialise(userId, item));
    }

    if (result.value.unresolved.length > 0) {
      this.logger.warn(
        { phrase, unresolved: result.value.unresolved },
        'meal interpretation left words unaccounted for',
      );
    }

    return {
      draftId: randomUUID(),
      phrase,
      summary: result.value.summary,
      items,
      unresolved: result.value.unresolved,
      totals: {
        kcal: round(sum(items, (i) => i.kcal)),
        proteinG: round(sum(items, (i) => i.proteinG)),
        carbsG: round(sum(items, (i) => i.carbsG)),
        fatG: round(sum(items, (i) => i.fatG)),
        fiberG: round(sum(items, (i) => i.fiberG)),
      },
      estimated: true,
    };
  }

  /**
   * Turn one model-described food into a real row this user owns.
   *
   * Created now rather than on confirm, because log_items.food_id is NOT NULL
   * and the client commits through the ordinary POST /v1/logs path. A draft
   * with no row behind it would need a second commit path that froze nutrients
   * its own way, and two ways to write a log entry is precisely what the
   * existing design refuses.
   *
   * Keyed on (source, source_id) with the user inside the key, so saying
   * "dosai" every morning reuses one row instead of accumulating a hundred.
   *
   * That row is this user's MEMORY of the food, and two rules make it one:
   *
   *   1. **The key ignores when they ate it.** See `memoryKey`. Keyed on the
   *      raw name, "mathiyam chicken biryani" was a different food from
   *      "chicken biryani" — one person, one dish, two rows, two estimates.
   *   2. **The first answer stands — the rates AND the portion.** Both are
   *      written once and not overwritten on a later mention. A model asked the
   *      same question twice answers differently, and a biryani that is 700
   *      kcal on Monday and 520 on Tuesday is not a tracker; the number has to
   *      be stable to be worth anything, even when it is only an estimate.
   *
   *      The portion is half of that and was the half left out. With only the
   *      rates remembered, the same sentence still moved between runs — one
   *      call reading a serving of biryani as 200 g and the next as 250 g, for
   *      a 90 kcal swing on one line with an identical rate behind it. Grams
   *      are the larger source of variance of the two, because a rate is a
   *      property of a dish and a portion is a guess about a plate.
   *
   *      The later answers are still recorded on the run for attribution; they
   *      just do not silently rewrite what the user has already been shown.
   */
  private async materialise(
    userId: string,
    item: AiMealItem & { date: string | null },
  ): Promise<AiMealItemDraft> {
    const sourceId = `${userId}:${memoryKey(item.name)}`;

    const foodId = await this.db.transaction(async (tx) => {
      const [food] = await tx
        .insert(schema.foods)
        .values({
          source: 'ai',
          sourceId,
          name: item.name,
          brand: null,
          // Not generic. A generic row is one that should outrank a branded
          // product in everybody's search, and an estimate has not earned that.
          isGeneric: false,
          searchText: normalizeSearchText(item.name, item.spokenAs),
          createdByUserId: userId,
        })
        .onConflictDoUpdate({
          target: [schema.foods.source, schema.foods.sourceId],
          set: { name: item.name },
        })
        .returning({ id: schema.foods.id });

      // Every state 'imputed', never 'known'. A model has measured nothing, and
      // 'known' is the word this schema uses for a value that came off a bench.
      await tx
        .insert(schema.foodNutrients)
        .values({
          foodId: food!.id,
          kcal: item.per100g.kcal,
          proteinG: item.per100g.proteinG,
          carbsG: item.per100g.carbsG,
          carbsState: 'imputed',
          fatG: item.per100g.fatG,
          fatState: 'imputed',
          fiberG: item.per100g.fiberG,
          fiberState: 'imputed',
        })
        // Nothing on conflict: the first estimate is the remembered one. See
        // the note on this method for why it is not refreshed.
        .onConflictDoNothing();

      // One portion, in the unit they counted in, so the next "5 dosai"
      // prefills from a row rather than from another model call.
      const perUnit = item.grams / item.quantity;
      if (Number.isFinite(perUnit) && perUnit > 0) {
        await tx
          .insert(schema.foodPortions)
          .values({
            foodId: food!.id,
            label: `1 ${item.unit}`,
            grams: round(perUnit),
            isDefault: true,
          })
          // Named target, not a bare `onConflictDoNothing()`.
          //
          // Without one there was nothing to conflict ON — `food_portions` had
          // no unique index — so every mention inserted another row and the
          // same label ended up with two weights. "2 eggs" was 100 g in one row
          // and 136 g in another, and which one a portion resolved to came down
          // to the order the planner returned them in.
          .onConflictDoNothing({
            target: [schema.foodPortions.foodId, schema.foodPortions.label],
          });
      }

      return food!.id;
    });

    const detail = await this.foods.findById(foodId);

    /**
     * The portion as the row now holds it, scaled to what they said this time.
     *
     * "5 dosai" and "3 dosai" are the same remembered 60 g unit and different
     * totals, so what is remembered is the per-unit weight and the count is
     * still read from the sentence. Falls back to the model's own total when
     * there is no remembered portion — a unit that divided to nothing on the
     * first mention leaves no row to find.
     */
    const rememberedUnit = detail.portions.find((p) => p.label === `1 ${item.unit}`);
    const grams = rememberedUnit ? round(rememberedUnit.grams * item.quantity) : item.grams;

    /**
     * The rates as the row now holds them.
     *
     * Nullable on the way out because the schema's three-state rule makes every
     * macro nullable — an unmeasured nutrient is not a zero. An AI row always
     * writes all five, so the fallback is here to satisfy the shape rather than
     * to cover a case this path produces.
     */
    const remembered = {
      kcal: detail.nutrients.kcal,
      proteinG: detail.nutrients.proteinG,
      carbsG: detail.nutrients.carbsG ?? item.per100g.carbsG,
      fatG: detail.nutrients.fatG ?? item.per100g.fatG,
      fiberG: detail.nutrients.fiberG ?? item.per100g.fiberG,
    };

    /**
     * Scaled from the STORED rates, not the ones this call produced.
     *
     * They are the same figures the first time and they can differ afterwards,
     * and when they differ the stored ones are what the row holds, what the
     * portion screen will show, and what a future log freezes. Scaling from the
     * model's answer instead would put a number on this screen that nothing
     * else in the system agrees with.
     */
    return {
      food: {
        id: detail.id,
        name: detail.name,
        brand: detail.brand,
        kcalPer100g: detail.kcalPer100g,
      },
      ...scaleToPortion({ ...item, grams, per100g: remembered }),
    };
  }
}

/**
 * Rates times grams, and nothing else.
 *
 * Extracted from the write path deliberately: this is the step that decides
 * what a user is told they ate, and it is the only part of this feature that
 * can be proven correct rather than merely reviewed. The model supplied
 * per-100g values and a gram weight; every figure below is a product of those
 * two, computed here. Nothing the model returned is passed through as a total.
 */
/**
 * What a food is called, for the purpose of remembering it.
 *
 * Time and sequence words are dropped, because they describe the sentence
 * rather than the food: somebody narrating a day says "mathiyam chicken
 * biryani" and "chicken biryani" about the same plate, and a key that keeps the
 * adverb files them as two dishes with two independent estimates.
 *
 * Nothing else is stripped. This is not a stop-word list and it must not become
 * one — "green" in "green chutney" and "half" in "half boiled egg" change what
 * the food IS, and a key that threw those away would collapse foods that are
 * genuinely different into one remembered number.
 *
 * Falls back to the full normalised name when every token is a time word, which
 * would otherwise key a food on the empty string and merge unrelated foods.
 */
export function memoryKey(name: string): string {
  const normalized = normalizeSearchText(name);
  const kept = normalized
    .split(' ')
    .filter((word) => word && !TIME_WORDS.has(word) && !SEQUENCE_WORDS.has(word));
  return kept.length > 0 ? kept.join(' ') : normalized;
}

export function scaleToPortion(
  item: AiMealItem & { date: string | null },
): Omit<AiMealItemDraft, 'food'> {
  const factor = item.grams / 100;
  return {
    spokenAs: item.spokenAs,
    quantity: item.quantity,
    unit: item.unit,
    // Passed straight through, null included. This function multiplies; it
    // does not decide what time, or which day, anybody ate.
    meal: item.meal ?? null,
    date: item.date,
    grams: round(item.grams),
    kcal: round(item.per100g.kcal * factor),
    proteinG: round(item.per100g.proteinG * factor),
    carbsG: round(item.per100g.carbsG * factor),
    fatG: round(item.per100g.fatG * factor),
    fiberG: round(item.per100g.fiberG * factor),
    confidence: item.confidence,
    quantityStated: item.quantityStated,
  };
}

function sum(items: AiMealItemDraft[], pick: (i: AiMealItemDraft) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

/** One decimal. These are estimates; more precision would be theatre. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Same shape as the resolver's phrase key: normalized text, so trivially
 * different spellings of one sentence group together in ai_runs.
 */
function hashOf(phrase: string): string {
  return createHash('sha256').update(normalizeSearchText(phrase)).digest('hex');
}
