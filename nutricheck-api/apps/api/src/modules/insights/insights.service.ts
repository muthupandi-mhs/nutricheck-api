import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  DaySummary,
  MacroShare,
  MealFacts,
  MealInsight,
  MealSlot,
} from '@nutricheck/contracts';
import { PROMPTS } from '@nutricheck/prompts';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CACHE } from '../../infrastructure/redis/redis.tokens';
import { AiService } from '../ai/ai.service';
import { LogsService } from '../logs/logs.service';
import { sumDay } from '../logs/nutrition-calculator';

/**
 * A note is stable until the meal changes, so it is cached against the meal's
 * CONTENTS rather than a clock. Editing a portion produces a different key and
 * therefore a fresh note; opening the screen again all afternoon does not.
 */
const CACHE_TTL_SECONDS = 60 * 60 * 24;

/**
 * The per-meal note.
 *
 * The division of labour here is the whole design: this class does every
 * calculation, and the model is handed the results to write a sentence about.
 * `InsightResult` has no numeric field, so there is nowhere for a figure the
 * model worked out itself to appear.
 *
 * Totals come from `sumDay` over the same frozen log values the day view
 * renders — not a second query with its own rounding. A note that disagreed
 * with the number printed above it would be worse than no note.
 */
@Injectable()
export class InsightsService {
  private readonly log = new Logger(InsightsService.name);

  constructor(
    private readonly logs: LogsService,
    private readonly ai: AiService,
    @Inject(REDIS_CACHE) private readonly redis: Redis,
  ) {}

  async mealInsight(
    userId: string,
    date: string,
    meal: MealSlot,
    tz: string,
  ): Promise<MealInsight> {
    const day = await this.logs.day(userId, date, tz);
    const facts = this.factsFor(day, meal, date);

    // Nothing logged in this slot: there is no note to write, and asking a
    // model to say something about an empty meal is how you get filler.
    if (facts.entryCount === 0) {
      return { facts, text: '', cached: false, model: null };
    }

    const key = this.cacheKey(userId, facts);
    const cached = await this.readCache(key);
    if (cached !== null) {
      return { facts, text: cached, cached: true, model: null };
    }

    if (!this.ai.isConfigured) {
      // Same degradation as everywhere else: the numbers still render, the
      // screen simply says less. Not an error the user can act on.
      return { facts, text: '', cached: false, model: null };
    }

    try {
      const result = await this.ai.insight(facts);
      const text = result.value.text.trim();
      if (text) await this.writeCache(key, text);
      return { facts, text, cached: false, model: result.model };
    } catch (error) {
      // A refusal, a timeout, an open circuit. The meal is logged either way,
      // and a missing sentence must never look like a failed log.
      this.log.warn(
        { meal, reason: error instanceof Error ? error.message : 'unknown' },
        'insight unavailable',
      );
      return { facts, text: '', cached: false, model: null };
    }
  }

  /**
   * Fold one meal slot out of the day.
   *
   * `remaining` is deliberately computed against the WHOLE day rather than this
   * meal, because "what is left" is the question the user is actually asking
   * when they look at a meal card at 2pm.
   */
  private factsFor(day: DaySummary, meal: MealSlot, date: string): MealFacts {
    const entries = day.entries.filter((entry) => entry.meal === meal);
    const totals = sumDay(entries.flatMap((entry) => entry.items.map((i) => i.nutrients)));
    const goal = day.goal;

    // A goal of 0 means "not set", not "a target of zero" — dividing by it
    // would produce Infinity, and reporting 0% would be a different lie.
    const target = (value: number): number | null => (value > 0 ? value : null);

    const share = (
      amount: number,
      goalValue: number,
      unmeasuredItems: number,
      itemsInMeal: number,
    ): MacroShare => {
      // Every item unmeasured is not a total of zero — it is no measurement.
      const measured = itemsInMeal > 0 && unmeasuredItems >= itemsInMeal ? null : amount;
      const t = target(goalValue);
      return {
        amount: measured,
        target: t,
        percentOfTarget:
          measured !== null && t !== null ? Math.round((measured / t) * 100) : null,
        unmeasuredItems,
      };
    };

    const itemCount = entries.reduce((n, entry) => n + entry.items.length, 0);

    return {
      meal,
      date,
      entryCount: entries.length,
      kcal: share(totals.kcal, goal.kcal, 0, itemCount),
      proteinG: share(totals.proteinG, goal.proteinG, 0, itemCount),
      carbsG: share(totals.carbsG, goal.carbsG, totals.carbsUnmeasuredItems, itemCount),
      fatG: share(totals.fatG, goal.fatG, totals.fatUnmeasuredItems, itemCount),
      fiberG: share(totals.fiberG, goal.fiberG, totals.fiberUnmeasuredItems, itemCount),
      remaining: {
        kcal: remaining(goal.kcal, day.totals.kcal),
        proteinG: remaining(goal.proteinG, day.totals.proteinG),
        carbsG: remaining(goal.carbsG, day.totals.carbsG),
        fatG: remaining(goal.fatG, day.totals.fatG),
        fiberG: remaining(goal.fiberG, day.totals.fiberG),
      },
    };
  }

  /**
   * Keyed on the meal's contents and the prompt version.
   *
   * Contents rather than a timestamp: correcting a portion should produce a new
   * note immediately, and re-opening the screen should not. The prompt version
   * is in the key for the same reason it is in the phrase cache — an edited
   * prompt whose old output is served for a day is an edit that appears not to
   * have worked.
   */
  private cacheKey(userId: string, facts: MealFacts): string {
    const shape = JSON.stringify([
      facts.meal,
      facts.date,
      facts.kcal.amount,
      facts.proteinG.amount,
      facts.carbsG.amount,
      facts.fatG.amount,
      facts.fiberG.amount,
      facts.remaining,
    ]);
    const digest = createHash('sha256').update(shape).digest('hex').slice(0, 16);
    return `insight:${PROMPTS.insight.version}:${userId}:${digest}`;
  }

  /** Cache failures are never fatal: a miss costs a call, an exception costs the note. */
  private async readCache(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, text: string): Promise<void> {
    try {
      await this.redis.set(key, text, 'EX', CACHE_TTL_SECONDS);
    } catch {
      // Losing the write costs one extra call next time, and nothing else.
    }
  }
}

/** Negative when the target is passed. Reported, never clamped to zero. */
function remaining(goal: number, consumed: number): number | null {
  if (goal <= 0) return null;
  return Math.round((goal - consumed) * 10) / 10;
}
