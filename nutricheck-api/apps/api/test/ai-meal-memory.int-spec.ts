import { schema } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { AiRunsService } from '../src/modules/ai/ai-runs.service';
import { AiService, type AiCallResult } from '../src/modules/ai/ai.service';
import type { AiMealItem, AiMealResult } from '../src/modules/ai/ai.schemas';
import { AiMealService } from '../src/modules/ai-meal/ai-meal.service';
import { memoryKey } from '../src/modules/ai-meal/ai-meal.service';
import { FoodsService } from '../src/modules/foods/foods.service';
import type { QuotaService } from '../src/modules/quota/quota.service';
import { startTestPostgres, type TestDatabase } from './postgres';

/**
 * The AI-meal path's memory of a food.
 *
 * This path does not consult the corpus — deliberately, because the corpus
 * carries almost no Tamil names and a dead end is worse than a visible
 * estimate. What stands in for the corpus is the row it writes the first time
 * somebody names a dish, so everything here is about that row being ONE row
 * with ONE set of numbers.
 *
 * The failure this guards against is not a crash. It is a tracker that says a
 * chicken biryani is 700 kcal on Monday and 520 on Tuesday, having asked the
 * same model the same question twice.
 */

/** Only `interpretMeal` is real; the rest exist because AiService is abstract. */
class FakeAi extends AiService {
  calls = 0;
  next: AiMealItem[] = [];

  get isConfigured(): boolean {
    return true;
  }

  async interpretMeal(): Promise<AiCallResult<AiMealResult>> {
    this.calls += 1;
    return {
      value: { summary: 'a meal', items: this.next, unresolved: [] },
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
      latencyMs: 1,
      stopReason: 'end_turn',
      model: 'claude-opus-5',
      promptVersion: 'ai-meal-v1',
      raw: { fake: true },
    };
  }

  async insight(): Promise<never> {
    throw new Error('unused');
  }
  async suggestTargets(): Promise<never> {
    throw new Error('unused');
  }
  async parse(): Promise<never> {
    throw new Error('unused');
  }
  async rerank(): Promise<never> {
    throw new Error('unused');
  }
  async suggestFoods(): Promise<never> {
    throw new Error('unused');
  }
  async weekReview(): Promise<never> {
    throw new Error('unused');
  }
  async identify(): Promise<never> {
    throw new Error('unused');
  }
  async chat(): Promise<never> {
    throw new Error('unused');
  }
}

/** The two calls this path makes. Redis and the daily limit are not the subject. */
const quota = {
  consume: async () => undefined,
  refund: async () => undefined,
} as unknown as QuotaService;

function item(over: Partial<AiMealItem> = {}): AiMealItem {
  return {
    name: 'chicken biryani',
    spokenAs: 'chickenbriyani',
    quantity: 1,
    unit: 'serving',
    grams: 250,
    per100g: { kcal: 280, proteinG: 16, carbsG: 30, fatG: 9, fiberG: 2 },
    confidence: 'low',
    meal: null,
    ...over,
  };
}

describe('ai-meal memory', () => {
  let pg: TestDatabase;
  let ai: FakeAi;
  let meals: AiMealService;

  beforeAll(async () => {
    pg = await startTestPostgres();
    ai = new FakeAi();
    meals = new AiMealService(pg.db, ai, new AiRunsService(pg.db), new FoodsService(pg.db), quota);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function newUser(tag: string): Promise<string> {
    const [user] = await pg.db
      .insert(schema.users)
      .values({ email: `${tag}-${randomUUID()}@example.com` })
      .returning({ id: schema.users.id });
    return user!.id;
  }

  describe('the key', () => {
    it('ignores when the food was eaten', () => {
      // "mathiyam" is Tamil for afternoon. It described the sentence, and it
      // ended up in a food name — which gave one person two biryanis.
      expect(memoryKey('mathiyam chicken biryani')).toBe(memoryKey('chicken biryani'));
      expect(memoryKey('kalaila lemon rice')).toBe(memoryKey('lemon rice'));
      expect(memoryKey('iravu 3 sappathi')).toBe(memoryKey('3 sappathi'));
    });

    it('keeps words that change what the food IS', () => {
      // The line this must not cross. A stop-word list would collapse these,
      // and they are genuinely different foods with different numbers.
      expect(memoryKey('green chutney')).not.toBe(memoryKey('chutney'));
      expect(memoryKey('half boiled egg')).not.toBe(memoryKey('boiled egg'));
      expect(memoryKey('chicken biryani')).not.toBe(memoryKey('mutton biryani'));
    });

    it('falls back rather than keying a food on nothing', () => {
      // Every token a time word. An empty key would merge unrelated foods into
      // one remembered number, which is worse than a useless key.
      expect(memoryKey('evening')).toBe('evening');
    });
  });

  describe('the row', () => {
    it('files a dish and the same dish with a time word as one food', async () => {
      const userId = await newUser('timeword');

      ai.next = [item()];
      await meals.interpret(userId, 'mathiyam chickenbriyani');
      ai.next = [item({ name: 'mathiyam chicken biryani' })];
      await meals.interpret(userId, 'chickenbriyani');

      const rows = await pg.db.select().from(schema.foods);
      const mine = rows.filter(r => r.createdByUserId === userId);
      expect(mine).toHaveLength(1);
    });

    it('keeps the first estimate when the model answers differently', async () => {
      /**
       * The whole point. A model asked the same question twice answers
       * differently, and a number that moves under somebody between two
       * mentions of the same dish is not a tracker.
       */
      const userId = await newUser('stable');

      ai.next = [item()];
      const first = await meals.interpret(userId, 'chickenbriyani');

      // The model changes its mind by a third.
      ai.next = [item({ per100g: { kcal: 180, proteinG: 9, carbsG: 20, fatG: 7, fiberG: 1.5 } })];
      const second = await meals.interpret(userId, 'chickenbriyani');

      expect(second.items[0]!.kcal).toBe(first.items[0]!.kcal);
      expect(second.items[0]!.food.kcalPer100g).toBe(280);
    });

    it('gives the same total for the same sentence twice', async () => {
      /**
       * The whole promise, end to end.
       *
       * Rates alone were not enough. With the portion still coming from the
       * model on every call, one run read a serving of biryani as 200 g and the
       * next as 250 g — same rate, 90 kcal apart, same sentence. Grams are the
       * larger of the two sources of drift.
       */
      const userId = await newUser('same-twice');

      ai.next = [item()];
      const first = await meals.interpret(userId, 'chickenbriyani');

      // The model changes its mind about BOTH on the second look.
      ai.next = [
        item({
          grams: 400,
          per100g: { kcal: 180, proteinG: 9, carbsG: 20, fatG: 7, fiberG: 1.5 },
        }),
      ];
      const second = await meals.interpret(userId, 'chickenbriyani');

      expect(second.items[0]!.grams).toBe(first.items[0]!.grams);
      expect(second.items[0]!.kcal).toBe(first.items[0]!.kcal);
      expect(second.totals.kcal).toBe(first.totals.kcal);
    });

    it('scales a remembered unit by what they said this time', async () => {
      // What is remembered is the weight of ONE, not the weight of that meal.
      // "5 dosai" and "3 dosai" are the same unit and different totals.
      const userId = await newUser('counted');

      ai.next = [item({ name: 'dosai', unit: 'dosai', quantity: 5, grams: 300 })];
      const five = await meals.interpret(userId, '5 dosai');

      ai.next = [item({ name: 'dosai', unit: 'dosai', quantity: 3, grams: 999 })];
      const three = await meals.interpret(userId, '3 dosai');

      expect(five.items[0]!.grams).toBe(300);
      // 60 g remembered per dosai, not the 999 the model just said.
      expect(three.items[0]!.grams).toBe(180);
    });

    it('does not accumulate a portion row per mention', async () => {
      // `onConflictDoNothing()` had nothing to conflict on before the unique
      // index existed, so every mention inserted another "1 serving" — and the
      // same label ended up holding two different weights.
      const userId = await newUser('portions');

      ai.next = [item()];
      await meals.interpret(userId, 'chickenbriyani');
      ai.next = [item({ grams: 400 })];
      await meals.interpret(userId, 'chickenbriyani');
      ai.next = [item({ grams: 150 })];
      await meals.interpret(userId, 'chickenbriyani');

      const [food] = (await pg.db.select().from(schema.foods)).filter(
        f => f.createdByUserId === userId,
      );
      const portions = (await pg.db.select().from(schema.foodPortions)).filter(
        p => p.foodId === food!.id,
      );

      expect(portions).toHaveLength(1);
      expect(portions[0]!.grams).toBe(250);
    });

    it('still gives two people their own memory of the same dish', async () => {
      // Per-user by design: the key has the user in it, and one person's guess
      // at their own biryani has no business becoming everybody's.
      const a = await newUser('mine');
      const b = await newUser('theirs');

      ai.next = [item()];
      await meals.interpret(a, 'chickenbriyani');
      ai.next = [item({ per100g: { kcal: 150, proteinG: 7, carbsG: 18, fatG: 4.5, fiberG: 1 } })];
      const forB = await meals.interpret(b, 'chickenbriyani');

      expect(forB.items[0]!.food.kcalPer100g).toBe(150);
    });
  });
});
