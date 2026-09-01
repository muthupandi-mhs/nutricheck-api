import { Inject, Injectable } from '@nestjs/common';
import type { LogWeight, WeightPoint, WeightSeries, WeightTrend } from '@nutricheck/contracts';
import { and, asc, count, desc, eq, gte, schema, type Database } from '@nutricheck/database';
import { ConflictProblem, NotFoundProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { GoalsService } from '../goals/goals.service';

/**
 * Body weight over time.
 *
 * Two invariants hold this module together, and both exist because the weight
 * lives in two places:
 *
 *   1. **`user_profiles.weight_kg` is the CURRENT weight.** Everything that
 *      does arithmetic — the goal calculator, the AI prompts, the targets
 *      preview — reads it, and none of them should learn about a log table to
 *      get one number.
 *   2. **`weight_logs` is the history.** Nothing computes against it except
 *      this screen.
 *
 * So a write to either has to reach the other, or the app shows one weight on
 * Home and a different one on the chart. Logging the latest weight updates the
 * profile and recomputes the goal (below); saving the profile writes a log row
 * (in `GoalsService.upsertProfile`, inside the same transaction that writes the
 * profile). Those are the only two doors.
 */
@Injectable()
export class WeightService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly goals: GoalsService,
  ) {}

  /**
   * The window to chart, plus the two readings that sit outside it and still
   * matter: the latest overall and the earliest overall.
   *
   * Three queries rather than one over all history. A user two years in has a
   * few hundred rows and pulling them all to compute a 90-day slope is work
   * that grows without bound for a chart that does not.
   */
  async series(userId: string, days: number): Promise<WeightSeries> {
    const from = shiftDays(todayUtc(), -days);

    const [windowRows, latest, earliest, profile] = await Promise.all([
      this.db
        .select({
          date: schema.weightLogs.measuredOn,
          weightKg: schema.weightLogs.weightKg,
        })
        .from(schema.weightLogs)
        .where(
          and(eq(schema.weightLogs.userId, userId), gte(schema.weightLogs.measuredOn, from)),
        )
        .orderBy(asc(schema.weightLogs.measuredOn)),
      this.edge(userId, 'latest'),
      this.edge(userId, 'earliest'),
      this.intendedRate(userId),
    ]);

    return {
      points: windowRows,
      current: latest,
      start: earliest,
      trend: trendOf(windowRows, profile),
    };
  }

  /**
   * Record a weight, and keep the profile in step with it.
   *
   * The profile is only written when this reading is the newest one there is.
   * Backfilling last Tuesday must not overwrite "what I weigh now" with a
   * figure that was already superseded — and it must not recompute the goal
   * either, since the goal follows the current weight and the current weight
   * has not changed.
   *
   * Both writes are one transaction for the reason the profile save is: a log
   * row that lands while the profile write fails leaves the chart and the Home
   * dial disagreeing about today, with nothing to reconcile them.
   */
  async log(userId: string, input: LogWeight, days: number): Promise<WeightSeries> {
    const measuredOn = input.date ?? todayUtc();
    const latest = await this.edge(userId, 'latest');
    // `>=` not `>`: re-logging the latest day is a correction to it, and a
    // correction to the newest reading is still the newest reading.
    const isNewest = !latest || measuredOn >= latest.date;

    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.weightLogs)
        .values({ userId, measuredOn, weightKg: input.weightKg })
        .onConflictDoUpdate({
          target: [schema.weightLogs.userId, schema.weightLogs.measuredOn],
          set: { weightKg: input.weightKg, createdAt: new Date() },
        });

      if (isNewest) {
        await tx
          .update(schema.userProfiles)
          .set({ weightKg: input.weightKg, updatedAt: new Date() })
          .where(eq(schema.userProfiles.userId, userId));
      }
    });

    /**
     * Outside the transaction, and deliberately.
     *
     * The goal recompute reads the profile it just wrote, appends a goal row,
     * and is the one part of this that can be redone later — `recalculate` is
     * idempotent for a given profile, and the profile save path calls it too.
     * Holding the transaction open across it would put the goal formula inside
     * the lock that every weight entry takes.
     *
     * A user with no profile yet cannot reach this screen, but the guard costs
     * a branch: recalculating against a profile that does not exist throws, and
     * the weight was still recorded correctly.
     */
    if (isNewest) {
      const profile = await this.goals.findProfile(userId);
      if (profile) await this.goals.recalculate(userId, profile);
    }

    return this.series(userId, days);
  }

  /**
   * Delete one reading.
   *
   * Two rules, both of them about what is left afterwards:
   *
   * **The last reading cannot be deleted.** `user_profiles.weight_kg` is NOT
   * NULL and every goal is derived from it, so there is no such thing as an
   * account with no weight. Allowing it would leave the profile holding a
   * figure with no record behind it — precisely the disagreement between the
   * dial and the chart that this table exists to prevent. Refused as a 409,
   * because no edit to the request would make it work.
   *
   * **Deleting the newest one promotes the one before it.** The profile follows
   * the newest reading on the way in, so it has to follow it on the way out
   * too; otherwise deleting today leaves the app insisting you still weigh what
   * today said. The goal is recomputed from the promoted figure for the same
   * reason it is recomputed on the way in.
   */
  async remove(userId: string, date: string, days: number): Promise<WeightSeries> {
    const latest = await this.edge(userId, 'latest');
    const wasNewest = latest?.date === date;

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: schema.weightLogs.id })
        .from(schema.weightLogs)
        .where(
          and(eq(schema.weightLogs.userId, userId), eq(schema.weightLogs.measuredOn, date)),
        )
        .limit(1);

      if (!row) throw new NotFoundProblem('Weight reading');

      // Counted INSIDE the transaction. Two requests deleting the last two
      // rows at once would each see two remaining and each be allowed through.
      const [tally] = await tx
        .select({ n: count() })
        .from(schema.weightLogs)
        .where(eq(schema.weightLogs.userId, userId));

      if ((tally?.n ?? 0) <= 1) {
        throw new ConflictProblem(
          'That is your only weight reading',
          'Every account has a current weight, and the targets are derived from it. Change this reading instead of deleting it.',
        );
      }

      await tx.delete(schema.weightLogs).where(eq(schema.weightLogs.id, row.id));

      if (wasNewest) {
        const [promoted] = await tx
          .select({
            date: schema.weightLogs.measuredOn,
            weightKg: schema.weightLogs.weightKg,
          })
          .from(schema.weightLogs)
          .where(eq(schema.weightLogs.userId, userId))
          .orderBy(desc(schema.weightLogs.measuredOn))
          .limit(1);

        // Guaranteed by the tally above: there were at least two, so at least
        // one survives. Asserted rather than assumed, because the alternative
        // is writing `undefined` into a NOT NULL column.
        if (!promoted) throw new ConflictProblem('No reading left', 'Nothing to promote.');

        await tx
          .update(schema.userProfiles)
          .set({ weightKg: promoted.weightKg, updatedAt: new Date() })
          .where(eq(schema.userProfiles.userId, userId));
      }
    });

    // Outside the transaction, for the reason `log` recomputes outside it.
    if (wasNewest) {
      const profile = await this.goals.findProfile(userId);
      if (profile) await this.goals.recalculate(userId, profile);
    }

    return this.series(userId, days);
  }

  /** The newest or oldest reading a user has, ignoring any window. */
  private async edge(userId: string, which: 'latest' | 'earliest'): Promise<WeightPoint | null> {
    const [row] = await this.db
      .select({
        date: schema.weightLogs.measuredOn,
        weightKg: schema.weightLogs.weightKg,
      })
      .from(schema.weightLogs)
      .where(eq(schema.weightLogs.userId, userId))
      .orderBy(
        which === 'latest'
          ? desc(schema.weightLogs.measuredOn)
          : asc(schema.weightLogs.measuredOn),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * The rate the user signed up for, as a signed kg/week.
   *
   * Null rather than 0 when maintaining: "no intended rate" and "an intended
   * rate of zero" read the same in a number and differently on a screen, and
   * only the first is true of somebody who never asked to move.
   */
  private async intendedRate(userId: string): Promise<number | null> {
    const [row] = await this.db
      .select({
        objective: schema.userProfiles.objective,
        rateKgPerWeek: schema.userProfiles.rateKgPerWeek,
      })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1);

    if (!row || row.objective === 'maintain') return null;
    return row.objective === 'lose' ? -row.rateKgPerWeek : row.rateKgPerWeek;
  }
}

/**
 * Least-squares slope through the readings, in kg per week.
 *
 * Null under two readings, and null when every reading is on the same day —
 * both are cases where there is no line, and a slope of zero would state
 * "holding steady" about a user who has weighed themselves once.
 *
 * x is days since the first reading, so the fit is over real elapsed time
 * rather than sample index. Weighing daily for a week and weighing weekly for
 * two months are the same number of points and very different slopes.
 */
function trendOf(points: WeightPoint[], intendedKgPerWeek: number | null): WeightTrend | null {
  if (points.length < 2) return null;

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const xs = points.map((p) => daysBetween(first.date, p.date));
  const spanDays = xs[xs.length - 1]!;
  if (spanDays === 0) return null;

  const n = points.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = points.reduce((a, p) => a + p.weightKg, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    num += dx * (points[i]!.weightKg - meanY);
    den += dx * dx;
  }

  // `den` is zero only when every x is identical, which `spanDays === 0` has
  // already caught. Guarded anyway rather than dividing and returning NaN into
  // a contract that says this is a number.
  const kgPerDay = den === 0 ? 0 : num / den;

  return {
    kgPerWeek: round(kgPerDay * 7, 2),
    deltaKg: round(last.weightKg - first.weightKg, 2),
    spanDays,
    intendedKgPerWeek,
  };
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}

function shiftDays(date: string, by: number): string {
  return new Date(Date.parse(date) + by * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Server-side "today" in UTC, used only to bound the window.
 *
 * The client sends its own local date for the reading itself. Here it is a
 * cutoff on a chart, where being a few hours out at either end of the world
 * costs nothing and is not worth a timezone on the query string.
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
