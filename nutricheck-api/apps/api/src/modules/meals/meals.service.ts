import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateMeal,
  LogMealRequest,
  LogEntry,
  SavedMeal,
} from '@nutricheck/contracts';
import { and, asc, desc, eq, schema, type Database } from '@nutricheck/database';
import { NotFoundProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { LogsService } from '../logs/logs.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Saved meals.
 *
 * The same mechanism as the repeat strip, applied to a group: "usual breakfast"
 * collapses a three-item log into one tap. PLAN calls it the highest-leverage
 * feature nobody asks for, and it is what makes day 30 feel different from day 1.
 */
@Injectable()
export class MealsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly logs: LogsService,
  ) {}

  /**
   * Point the phrase that produced an entry at the meal just saved from it.
   *
   * Silent when the entry had no phrase — a meal built by hand, or saved from a
   * repeat-tap, has no sentence behind it and that is not an error. Matching on
   * the text rather than an entry id is deliberate: `user_phrases` is keyed by
   * (user, phrase), so every past and future use of that sentence is promoted
   * at once, which is what the user means by "save this as my usual".
   */
  private async linkPhraseToMeal(
    tx: Tx,
    userId: string,
    entryId: string,
    mealId: string,
  ): Promise<void> {
    const [entry] = await tx
      .select({ phrase: schema.logEntries.phrase })
      .from(schema.logEntries)
      .where(
        and(eq(schema.logEntries.id, entryId), eq(schema.logEntries.userId, userId)),
      )
      .limit(1);

    const phrase = entry?.phrase?.trim();
    if (!phrase) return;

    await tx
      .update(schema.userPhrases)
      .set({ mealId })
      .where(
        and(
          eq(schema.userPhrases.userId, userId),
          eq(schema.userPhrases.phrase, phrase),
        ),
      );
  }

  async list(userId: string): Promise<SavedMeal[]> {
    const meals = await this.db
      .select()
      .from(schema.meals)
      .where(eq(schema.meals.userId, userId))
      .orderBy(desc(schema.meals.createdAt));

    return Promise.all(meals.map((meal) => this.hydrate(meal)));
  }

  async findById(userId: string, mealId: string): Promise<SavedMeal> {
    const [meal] = await this.db
      .select()
      .from(schema.meals)
      .where(and(eq(schema.meals.id, mealId), eq(schema.meals.userId, userId)))
      .limit(1);

    if (!meal) throw new NotFoundProblem('Meal');
    return this.hydrate(meal);
  }

  /**
   * Create from explicit items, or from a log entry that already worked — the
   * "that was right, keep it" path, which is how a phrase becomes a one-tap
   * meal on its second use.
   */
  async create(userId: string, input: CreateMeal): Promise<SavedMeal> {
    const items = input.fromEntryId
      ? await this.itemsFromEntry(userId, input.fromEntryId)
      : (input.items ?? []).map((i) => ({
          foodId: i.foodId,
          grams: i.grams,
          quantityType: i.quantityType,
        }));

    if (items.length === 0) throw new NotFoundProblem('Meal items');

    const mealId = await this.db.transaction(async (tx) => {
      const [meal] = await tx
        .insert(schema.meals)
        .values({ userId, name: input.name })
        .returning({ id: schema.meals.id });

      await tx.insert(schema.mealItems).values(
        items.map((item) => ({
          mealId: meal!.id,
          foodId: item.foodId,
          grams: item.grams,
          quantityType: item.quantityType,
        })),
      );

      // Close the loop on the phrase that got here. Saving a meal from an entry
      // IS the promotion the composer offered on that sentence's second use, so
      // the phrase should stop reading as "clock" and start reading as the meal
      // name. Doing it here rather than in a follow-up call keeps the two facts
      // from disagreeing when the second call is the one that fails.
      if (input.fromEntryId) {
        await this.linkPhraseToMeal(tx, userId, input.fromEntryId, meal!.id);
      }

      return meal!.id;
    });

    return this.findById(userId, mealId);
  }

  async remove(userId: string, mealId: string): Promise<void> {
    const deleted = await this.db
      .delete(schema.meals)
      .where(and(eq(schema.meals.id, mealId), eq(schema.meals.userId, userId)))
      .returning({ id: schema.meals.id });

    if (deleted.length === 0) throw new NotFoundProblem('Meal');
  }

  /**
   * One tap. Logs every item at its saved portion through the ordinary commit
   * path, so the freeze-at-commit and idempotency rules apply identically —
   * there is no second way to write a log entry.
   */
  async log(
    userId: string,
    mealId: string,
    input: LogMealRequest,
  ): Promise<{ entry: LogEntry; created: boolean }> {
    const meal = await this.findById(userId, mealId);

    return this.logs.commit(userId, {
      clientId: input.clientId,
      loggedAt: input.loggedAt,
      meal: input.meal,
      // 'repeat' is the source that bypasses the confirm sheet: there is no
      // estimate here to check, only portions the user set themselves.
      source: 'repeat',
      phrase: null,
      draftId: null,
      items: meal.items.map((item) => ({
        foodId: item.food.id,
        grams: item.grams,
        quantityType: item.quantityType,
        quantitySource: 'user_portion' as const,
        learnedUnitLabel: null,
      })),
    });
  }

  private async itemsFromEntry(userId: string, entryId: string) {
    const entry = await this.logs.getById(userId, entryId);
    return entry.items.map((item) => ({
      foodId: item.food.id,
      grams: item.grams,
      quantityType: item.quantityType,
    }));
  }

  private async hydrate(
    meal: typeof schema.meals.$inferSelect,
  ): Promise<SavedMeal> {
    const rows = await this.db
      .select({
        id: schema.mealItems.id,
        grams: schema.mealItems.grams,
        quantityType: schema.mealItems.quantityType,
        foodId: schema.foods.id,
        foodName: schema.foods.name,
        foodBrand: schema.foods.brand,
        kcalPer100g: schema.foodNutrients.kcal,
        proteinPer100g: schema.foodNutrients.proteinG,
      })
      .from(schema.mealItems)
      .innerJoin(schema.foods, eq(schema.foods.id, schema.mealItems.foodId))
      .innerJoin(schema.foodNutrients, eq(schema.foodNutrients.foodId, schema.foods.id))
      .where(eq(schema.mealItems.mealId, meal.id))
      .orderBy(asc(schema.mealItems.id));

    let kcal = 0;
    let proteinG = 0;
    for (const row of rows) {
      kcal += (row.kcalPer100g * row.grams) / 100;
      proteinG += (row.proteinPer100g * row.grams) / 100;
    }

    return {
      id: meal.id,
      name: meal.name,
      items: rows.map((row) => ({
        id: row.id,
        food: {
          id: row.foodId,
          name: row.foodName,
          brand: row.foodBrand,
          kcalPer100g: row.kcalPer100g,
        },
        grams: row.grams,
        quantityType: row.quantityType,
      })),
      // Indicative only — the authoritative numbers are frozen at commit.
      totals: { kcal: round2(kcal), proteinG: round2(proteinG) },
      createdAt: meal.createdAt.toISOString(),
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
