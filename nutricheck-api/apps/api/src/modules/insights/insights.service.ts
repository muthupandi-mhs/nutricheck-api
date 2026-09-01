import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  DaySummary,
  MacroShare,
  MealFacts,
  MealInsight,
  MealSlot,
  WeekFacts,
  WeekReview,
} from '@nutricheck/contracts';
import { PROMPTS } from '@nutricheck/prompts';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { QuotaExhaustedException } from '../../common/problems';
import { REDIS_CACHE } from '../../infrastructure/redis/redis.tokens';
import { AiRunsService } from '../ai/ai-runs.service';
import { AiService } from '../ai/ai.service';
import { LogsService } from '../logs/logs.service';
import { sumDay } from '../logs/nutrition-calculator';
import { QuotaService } from '../quota/quota.service';
import { WeightService } from '../weight/weight.service';
import { weekFactsOf } from './week-facts';

/**
 * A note is stable until the meal changes, so it is cached against the meal's
 * CONTENTS rather than a clock. Editing a portion produces a different key and
 * therefore a fresh note; opening the screen again all afternoon does not.
 */
const CACHE_TTL_SECONDS = 60 * 60 * 24;

/**
 * A week that has already ended can never produce different figures, so its
 * review is written once and kept. Thirty days, not forever, only because an
 * unbounded key is a leak with a slow fuse.
 */
const FINISHED_WEEK_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * How far back the weekly review's weight trend is fitted, ending on the last
 * day of the week under review.
 *
 * Four weeks rather than one. A seven-day window holds one or two weigh-ins for
 * most people, and a least-squares line through two points is just those two
 * points — at which stage a single dehydrated Tuesday IS the trend, which is
 * exactly what fitting a line was supposed to prevent. See
 * `WeightService.trendEndingOn`.
 */
const WEIGHT_FIT_DAYS = 28;

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
    private readonly aiRuns: AiRunsService,
    private readonly quota: QuotaService,
    private readonly weight: WeightService,
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

      // This call costs money, and until now it was the one model call that
      // left no row — so a heavy insight user looked free, and their spend
      // never counted toward RESOLVE_USER_DAILY_SPEND_USD.
      //
      // Recorded outside the note's own success path: losing the row is an
      // accounting problem, and it must not cost the user a sentence we have
      // already paid for.
      await this.aiRuns
        .recordCall(userId, 'insight', this.factsHash(facts), result)
        .catch((error: unknown) => {
          this.log.error(
            { meal, reason: error instanceof Error ? error.message : 'unknown' },
            'insight call was not recorded — its cost is missing from attribution',
          );
        });

      const text = result.value.text.trim();
      if (text) await this.writeCache(key, text, CACHE_TTL_SECONDS);
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
   * The week in review — the note above the Insights charts.
   *
   * Reads as the meal note does, one scale up, and the three departures from it
   * are all about a week costing more than a sentence:
   *
   * **The window ends where the caller says.** Insights pages backwards, so a
   * review is asked for a week that may be months old. Everything here is
   * anchored on `date` — the previous week, the weight trend — because reading
   * this week's slope beside that week's meals would pair one week's food with
   * another week's outcome.
   *
   * **The cache holds much longer for a finished week.** A past week cannot
   * change and its review is written once and served forever after; the current
   * one changes with every meal, so its key carries the figures and a day's TTL
   * bounds how stale the last entry can be. `cacheKey` is where that lives.
   *
   * **It respects the daily AI ceiling, after the cache.** Same ordering as
   * `IdeasService` and for the same reason: refusing to re-render a review the
   * user has already been shown and already paid for is a quota rule they would
   * experience as the app forgetting.
   */
  async weekReview(userId: string, date: string, tz: string): Promise<WeekReview> {
    /**
     * Three reads, and all of them before the cache lookup.
     *
     * The figures ARE the cache key for a live week — a review written at
     * breakfast is the wrong review after dinner — so they have to be in hand
     * before the key can be built. The alternative is keying on the date alone
     * and serving somebody this morning's summary of a day that has since had
     * two meals in it.
     */
    const [week, previous, weight] = await Promise.all([
      this.logs.week(userId, date, tz),
      this.logs.week(userId, shiftDays(date, -7), tz),
      this.weight.trendEndingOn(userId, date, WEIGHT_FIT_DAYS),
    ]);

    const facts = weekFactsOf(week, previous, weight);

    // A week with nothing in it has nothing to review, and a model asked to
    // write about it produces encouragement — which is the one thing this
    // surface must not do to somebody who has not logged for a week.
    if (facts.loggedDays === 0) {
      return { facts, text: '', cached: false, model: null };
    }

    const key = this.weekCacheKey(userId, facts);
    const cached = await this.readCache(key);
    if (cached !== null) {
      return { facts, text: cached, cached: true, model: null };
    }

    if (!this.ai.isConfigured) {
      // The same degradation every AI surface here makes: the figures render
      // and the screen says less. Not an error the user can act on.
      return { facts, text: '', cached: false, model: null };
    }

    const status = await this.quota.status(userId);
    if (status.blocked) throw new QuotaExhaustedException(status.resetAt);

    await this.quota.consume(userId);

    let result;
    try {
      result = await this.ai.weekReview(facts);
    } catch (error) {
      // A failed call must not cost a unit. The resolver's rule: a bad minute
      // upstream is not the user's doing.
      await this.quota.refund(userId).catch(() => undefined);
      this.log.warn(
        { date, reason: error instanceof Error ? error.message : 'unknown' },
        'week review unavailable',
      );
      return { facts, text: '', cached: false, model: null };
    }

    await this.aiRuns
      .recordCall(userId, 'review', this.weekFactsHash(facts), result)
      .catch((error: unknown) => {
        this.log.error(
          { date, reason: error instanceof Error ? error.message : 'unknown' },
          'week review call was not recorded — its cost is missing from attribution',
        );
      });

    const text = result.value.text.trim();
    if (text) await this.writeCache(key, text, this.ttlFor(facts));
    return { facts, text, cached: false, model: result.model };
  }

  /**
   * Keyed on the figures and the prompt version, never on the date alone.
   *
   * The date alone would be wrong in both directions at once: a live week's
   * review would be frozen at whatever it said when the tab was first opened,
   * and an edited portion in a past week would never produce a new one. Hashing
   * the facts means a week that has not changed is free and a week that has
   * changed is re-reviewed, with nothing to remember to invalidate.
   *
   * The prompt version is in the key for the reason it is in the phrase cache:
   * an edited prompt whose old output keeps being served is an edit that
   * appears not to have worked.
   */
  private weekCacheKey(userId: string, facts: WeekFacts): string {
    return `weekreview:${PROMPTS.weekReview.version}:${userId}:${this.weekFactsHash(facts).slice(0, 16)}`;
  }

  /** The figures that were sent, as one hash — the key's basis and `input_hash`. */
  private weekFactsHash(facts: WeekFacts): string {
    return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  }

  /**
   * A finished week keeps its review for thirty days; a live one for a day.
   *
   * Both are long, and the split is not really about staleness — the key holds
   * the figures, so a changed week produces a different entry either way and
   * neither TTL can serve a review of numbers that have moved. It is about how
   * many DEAD entries a user accumulates. A live week is re-keyed on every meal
   * and would otherwise leave a month of superseded reviews in Redis; a
   * finished week has exactly one key that will ever be asked for, and paging
   * back to it in March should not cost a model call.
   */
  private ttlFor(facts: WeekFacts): number {
    const finished = facts.to < todayUtc();
    return finished ? FINISHED_WEEK_TTL_SECONDS : CACHE_TTL_SECONDS;
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
    return `insight:${PROMPTS.insight.version}:${userId}:${this.factsHash(facts).slice(0, 16)}`;
  }

  /**
   * The facts that were sent, as one hash — the cache key's basis, and the
   * `input_hash` on the ai_runs row, so a note in the dashboard can be traced
   * back to the numbers that produced it.
   */
  private factsHash(facts: MealFacts): string {
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
    return createHash('sha256').update(shape).digest('hex');
  }

  /** Cache failures are never fatal: a miss costs a call, an exception costs the note. */
  private async readCache(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, text: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, text, 'EX', ttlSeconds);
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

const MS_PER_DAY = 86_400_000;

/**
 * Move a `YYYY-MM-DD` by whole days, used only to reach the week before this
 * one. Parsing as UTC and adding a fixed day is safe here because both ends are
 * plain dates with no clock attached — this never touches a log boundary, which
 * is `LogsService`'s job and is done in the user's zone.
 */
function shiftDays(date: string, by: number): string {
  return new Date(Date.parse(date) + by * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Server "today" in UTC, and it decides one thing only: how long to keep a
 * review in Redis. A user a few hours ahead of UTC can have the last day of
 * their week judged unfinished for those hours, which costs a shorter TTL on
 * one entry and nothing else. Not worth a timezone to fix.
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
