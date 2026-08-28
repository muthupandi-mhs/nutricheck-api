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
import { assignMealTimes } from './meal-times';
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

  async interpret(userId: string, phrase: string): Promise<AiMealDraft> {
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

    const items: AiMealItemDraft[] = [];
    for (const item of timed) {
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
   * The upsert refreshes the estimate, which is what you want the day the
   * prompt improves.
   */
  private async materialise(
    userId: string,
    item: AiMealItem,
  ): Promise<AiMealItemDraft> {
    const sourceId = `${userId}:${normalizeSearchText(item.name)}`;

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
        .onConflictDoUpdate({
          target: schema.foodNutrients.foodId,
          set: {
            kcal: item.per100g.kcal,
            proteinG: item.per100g.proteinG,
            carbsG: item.per100g.carbsG,
            fatG: item.per100g.fatG,
            fiberG: item.per100g.fiberG,
          },
        });

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
          .onConflictDoNothing();
      }

      return food!.id;
    });

    const detail = await this.foods.findById(foodId);

    return {
      food: {
        id: detail.id,
        name: detail.name,
        brand: detail.brand,
        kcalPer100g: detail.kcalPer100g,
      },
      ...scaleToPortion(item),
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
export function scaleToPortion(
  item: AiMealItem,
): Omit<AiMealItemDraft, 'food'> {
  const factor = item.grams / 100;
  return {
    spokenAs: item.spokenAs,
    quantity: item.quantity,
    unit: item.unit,
    // Passed straight through, null included. This function multiplies; it
    // does not decide what time anybody ate.
    meal: item.meal ?? null,
    grams: round(item.grams),
    kcal: round(item.per100g.kcal * factor),
    proteinG: round(item.per100g.proteinG * factor),
    carbsG: round(item.per100g.carbsG * factor),
    fatG: round(item.per100g.fatG * factor),
    fiberG: round(item.per100g.fiberG * factor),
    confidence: item.confidence,
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
