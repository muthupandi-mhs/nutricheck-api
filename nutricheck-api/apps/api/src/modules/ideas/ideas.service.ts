import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  normalizeSearchText,
  type FoodIdea,
  type FoodIdeas,
  type MealSlot,
  type RemainingTargets,
} from '@nutricheck/contracts';
import { schema, type Database } from '@nutricheck/database';
import { PROMPTS } from '@nutricheck/prompts';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { QuotaExhaustedException } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { REDIS_CACHE } from '../../infrastructure/redis/redis.tokens';
import { AiRunsService } from '../ai/ai-runs.service';
import { AiService } from '../ai/ai.service';
import type { IdeaItem } from '../ai/ai.schemas';
import { FoodsService } from '../foods/foods.service';
import { GoalsService } from '../goals/goals.service';
import { LogsService } from '../logs/logs.service';
import { QuotaService } from '../quota/quota.service';
import { atwaterCheck, fibreIsPossible } from './atwater';

/**
 * What to eat next, for this person, with this much of the day left.
 *
 * The division of labour is the one the insight path uses: this class does
 * every calculation and hands the model the results. What is different, and
 * what makes this the riskiest surface in the app, is that the model answers
 * with nutrition rather than with a sentence about it.
 *
 * Four things bound that, in the order they run:
 *
 *   1. The gap is computed HERE, from the same day view the Today screen
 *      renders. The model is handed "480 kcal left, 52 g of protein left" and
 *      never the entries — so there is no arithmetic available for it to get
 *      wrong, and this tab cannot disagree with that screen about a total.
 *   2. Every idea is Atwater-checked and a failing one is DROPPED. See
 *      `atwater.ts`: this is the check the meal path does not have, and this
 *      path needs it precisely because nobody asked for these numbers.
 *   3. The model supplies RATES; every total the user reads is computed in
 *      `scaleIdea` from a rate and a gram weight.
 *   4. Rows are written source 'ai', owned by the person who opened the tab,
 *      every nutrient state 'imputed' — so the app shows a `~`, and nobody
 *      else's search ever sees them.
 *
 * Nothing here commits a log. Tapping an idea opens the ordinary portion
 * screen, which is the one place a log entry is written.
 */

/**
 * Ideas are stable until the day's totals move, so they are cached against the
 * GAP rather than a clock — logging a meal produces a different key and
 * therefore fresh ideas; re-opening the tab all afternoon does not.
 *
 * The TTL is short next to the insight cache's day, because the key is not the
 * whole truth here: the right suggestion at 9am and at 9pm differ even when
 * nothing has been logged between them, and while `nextMeal` is in the key the
 * clock moves through it continuously. Two hours is roughly one meal.
 */
const CACHE_TTL_SECONDS = 60 * 60 * 2;

/**
 * The gap is rounded to these before it reaches the cache key.
 *
 * Without it the key is effectively unique per request: a gap of 481 kcal and
 * one of 479 are the same question, and keying on the exact figure would bill a
 * fresh call for every gram of curd logged. Fifty calories and five grams are
 * below the resolution at which the advice would actually change.
 */
const KCAL_BUCKET = 50;
const GRAM_BUCKET = 5;

@Injectable()
export class IdeasService {
  private readonly log = new Logger(IdeasService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_CACHE) private readonly redis: Redis,
    private readonly ai: AiService,
    private readonly aiRuns: AiRunsService,
    private readonly foods: FoodsService,
    private readonly goals: GoalsService,
    private readonly logs: LogsService,
    private readonly quota: QuotaService,
  ) {}

  get isConfigured(): boolean {
    return this.ai.isConfigured;
  }

  async ideasFor(
    userId: string,
    date: string,
    tz: string,
    now = new Date(),
  ): Promise<FoodIdeas> {
    const [profile, day] = await Promise.all([
      this.goals.getProfile(userId),
      this.logs.day(userId, date, tz),
    ]);

    const remaining: RemainingTargets = {
      kcal: left(day.goal.kcal, day.totals.kcal),
      proteinG: left(day.goal.proteinG, day.totals.proteinG),
      carbsG: left(day.goal.carbsG, day.totals.carbsG),
      fatG: left(day.goal.fatG, day.totals.fatG),
      fiberG: left(day.goal.fiberG, day.totals.fiberG),
    };

    const nextMeal = mealSlotFor(now, tz);

    const nothing = (note: string): FoodIdeas => ({
      date,
      remaining,
      ideas: [],
      note,
      estimated: true,
      cached: false,
    });

    const key = this.cacheKey(userId, date, remaining, nextMeal);

    // Cache first, and before the quota check. Somebody who has used their
    // allowance should still see the list they were shown this afternoon —
    // refusing to re-render something already paid for and already displayed is
    // a quota rule the user experiences as the app forgetting.
    const hit = await this.readCache(key);
    if (hit) return { ...hit, date, remaining, cached: true };

    if (!this.ai.isConfigured) {
      // The degradation every AI surface here makes. The gap still renders and
      // the tab has nothing to suggest, which is a state rather than an error
      // the user can do anything about.
      return nothing('');
    }

    const status = await this.quota.status(userId);
    if (status.blocked) throw new QuotaExhaustedException(status.resetAt);

    await this.quota.consume(userId);

    let result;
    try {
      result = await this.ai.suggestFoods({
        profile,
        goal: day.goal,
        eaten: day.totals,
        remaining,
        entryCount: day.entries.length,
        nextMeal,
      });
    } catch (error) {
      // A failed call should not cost a unit — the resolver's rule, and the
      // reasoning is identical: a bad minute upstream is not the user's doing.
      await this.quota.refund(userId).catch(() => undefined);
      this.log.warn(
        { date, reason: error instanceof Error ? error.message : 'unknown' },
        'food ideas unavailable',
      );
      return nothing('');
    }

    await this.aiRuns
      .recordCall(userId, 'ideas', hashOf(remaining, nextMeal), result)
      .catch((error: unknown) => {
        // The trade the insight and targets paths make: losing the row is an
        // accounting problem, and it must not cost the user an answer that has
        // already been paid for.
        this.log.error(
          { reason: error instanceof Error ? error.message : 'unknown' },
          'ideas call was not recorded — its cost is missing from attribution',
        );
      });

    const usable = result.value.ideas.filter((item) => this.isSound(item));

    const ideas: FoodIdea[] = [];
    for (const item of usable) {
      ideas.push(await this.materialise(userId, item));
    }

    const answer: FoodIdeas = {
      date,
      remaining,
      ideas,
      note: result.value.note.trim(),
      estimated: true,
      cached: false,
    };

    // Only a list with something on it is worth keeping. Caching an empty
    // answer would hold one bad minute for two hours.
    if (ideas.length > 0) await this.writeCache(key, answer);

    return answer;
  }

  /**
   * Both arithmetic checks, and a log line whenever either fails.
   *
   * The line is the reason this is a method rather than an inline filter. An
   * idea dropped silently looks to everybody like a model that returned three
   * suggestions instead of five; rates that consistently fail Atwater are a
   * prompt problem, and this is the only place that would ever surface.
   */
  private isSound(item: IdeaItem): boolean {
    const energy = atwaterCheck(item);
    if (!energy.ok) {
      this.log.warn(
        {
          name: item.name,
          statedKcal: energy.statedKcal,
          impliedKcal: energy.impliedKcal,
          promptVersion: PROMPTS.ideas.version,
        },
        'idea dropped — its calories disagree with its own macros',
      );
      return false;
    }

    if (!fibreIsPossible(item)) {
      this.log.warn(
        {
          name: item.name,
          fiberG: item.per100g.fiberG,
          carbsG: item.per100g.carbsG,
          promptVersion: PROMPTS.ideas.version,
        },
        'idea dropped — more fibre than carbohydrate',
      );
      return false;
    }

    return true;
  }

  /**
   * Turn one suggested food into a real row this user owns.
   *
   * Created now rather than when the user taps, for the reason the meal path
   * creates its rows up front: the tap opens the portion screen, which takes a
   * food id and commits through the ordinary log route. A card with no row
   * behind it would need a second commit path that froze nutrients its own way.
   *
   * Keyed on (source, source_id) with the user inside the key, so a tab that
   * suggests curd every afternoon reuses one row instead of accumulating a
   * hundred. The upsert refreshes the estimate, which is what you want the day
   * the prompt improves.
   */
  private async materialise(userId: string, item: IdeaItem): Promise<FoodIdea> {
    const sourceId = `${userId}:${normalizeSearchText(item.name)}`;

    const foodId = await this.db.transaction(async (tx) => {
      const [food] = await tx
        .insert(schema.foods)
        .values({
          source: 'ai',
          sourceId,
          name: item.name,
          brand: null,
          // Not generic. A generic row outranks branded products in everybody's
          // search, and an estimate has not earned that.
          isGeneric: false,
          searchText: normalizeSearchText(item.name),
          createdByUserId: userId,
        })
        .onConflictDoUpdate({
          target: [schema.foods.source, schema.foods.sourceId],
          set: { name: item.name },
        })
        .returning({ id: schema.foods.id });

      // Every state 'imputed', never 'known'. Nothing here came off a bench.
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

      // The suggested serving, stored as the default portion, so the portion
      // screen opens on the amount the card described rather than on a bare
      // 100 g. Without it the figures on the card and the figures on the next
      // screen disagree at exactly the moment the user is deciding whether to
      // trust either of them.
      await tx
        .insert(schema.foodPortions)
        .values({
          foodId: food!.id,
          label: item.servingLabel,
          grams: round(item.grams),
          isDefault: true,
        })
        .onConflictDoNothing();

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
      ...scaleIdea(item),
    };
  }

  /**
   * Keyed on the GAP — not on the user's totals, and not on a clock.
   *
   * Bucketed, because the exact gap changes with every gram logged and the
   * advice does not. The prompt version is in the key for the reason it is in
   * every other cache key here: an edited prompt whose old output is served for
   * two hours is an edit that appears not to have worked.
   */
  private cacheKey(
    userId: string,
    date: string,
    remaining: RemainingTargets,
    nextMeal: MealSlot,
  ): string {
    return [
      'ideas',
      PROMPTS.ideas.version,
      userId,
      date,
      nextMeal,
      hashOf(remaining, nextMeal).slice(0, 16),
    ].join(':');
  }

  /** Cache failures are never fatal: a miss costs a call, an exception costs the tab. */
  private async readCache(key: string): Promise<FoodIdeas | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as FoodIdeas) : null;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, value: FoodIdeas): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    } catch {
      // Losing the write costs one extra call, and nothing else.
    }
  }
}

/**
 * Rates times grams, and nothing else.
 *
 * The counterpart of the meal path's `scaleToPortion`, kept separate rather
 * than shared: the two shapes differ — this one carries a reason and a serving
 * label — and this is the step that decides what a user is told a suggestion
 * contains. Every figure below is a product of a per-100g rate and a gram
 * weight, computed here. Nothing the model returned is passed through as a
 * total, because there is no field in which it could have sent one.
 */
export function scaleIdea(item: IdeaItem): Omit<FoodIdea, 'food'> {
  const factor = item.grams / 100;
  return {
    reason: item.reason,
    grams: round(item.grams),
    servingLabel: item.servingLabel,
    kcal: round(item.per100g.kcal * factor),
    proteinG: round(item.per100g.proteinG * factor),
    carbsG: round(item.per100g.carbsG * factor),
    fatG: round(item.per100g.fatG * factor),
    fiberG: round(item.per100g.fiberG * factor),
    confidence: item.confidence,
  };
}

/** Negative when the target is passed. Reported, never clamped to zero. */
function left(goal: number, consumed: number): number | null {
  if (goal <= 0) return null;
  return Math.round((goal - consumed) * 10) / 10;
}

/**
 * The gap that produced a list, as one hash — the cache key's basis and the
 * `input_hash` on the ai_runs row, so a suggestion in the dashboard can be
 * traced back to the situation that produced it.
 *
 * Bucketed before hashing. See KCAL_BUCKET: an unbucketed key never hits.
 */
function hashOf(remaining: RemainingTargets, nextMeal: MealSlot): string {
  const bucket = (value: number | null, size: number): number | null =>
    value === null ? null : Math.round(value / size) * size;

  const shape = JSON.stringify([
    bucket(remaining.kcal, KCAL_BUCKET),
    bucket(remaining.proteinG, GRAM_BUCKET),
    bucket(remaining.carbsG, GRAM_BUCKET),
    bucket(remaining.fatG, GRAM_BUCKET),
    bucket(remaining.fiberG, GRAM_BUCKET),
    nextMeal,
  ]);

  return createHash('sha256').update(shape).digest('hex');
}

/**
 * Which meal the clock is in, in the USER'S zone.
 *
 * The zone is not decoration. The server runs in UTC, and taking the hour off
 * its own clock would tell the model that an Indian user at 8pm was eating
 * mid-afternoon — producing breakfast suggestions at dinner, from a system that
 * already carries the user's zone through every other day-boundary decision it
 * makes.
 */
export function mealSlotFor(now: Date, tz: string): MealSlot {
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: tz,
      }).format(now),
    );
  } catch {
    // An unknown zone is a bad request, and not worth failing a whole tab over.
    hour = now.getUTCHours();
  }

  // 24 rather than 0 is what `hour12: false` returns for midnight in some ICU
  // builds. Both land in the same slot, but only because this is written to.
  if (hour >= 24) hour = 0;

  if (hour < 11) return 'breakfast';
  if (hour < 16) return 'lunch';
  if (hour < 22) return 'dinner';
  return 'snack';
}

/** One decimal. These are estimates; more precision would be theatre. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}
