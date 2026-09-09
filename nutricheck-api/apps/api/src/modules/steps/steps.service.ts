import { Inject, Injectable } from '@nestjs/common';
import type { LogSteps, StepPoint, StepsReport } from '@nutricheck/contracts';
import { and, eq, gte, lte, schema, type Database } from '@nutricheck/database';
import { NotFoundProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';

/**
 * Walking steps, per day.
 *
 * The stripped-down half of what `WeightService` does: an upsert on
 * `(user, day)` and a windowed read, with none of weight's coupling to the
 * profile or the goal calculator — nothing else in the app derives from a
 * step count, so a write here never has to reach another table.
 */
@Injectable()
export class StepsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Every day in `[today - days, today]`, gap-filled, with the aggregates
   * over it.
   *
   * A rolling window ending today, like `WeightService.series` — not a
   * calendar month like `logs.month`, since there is no calendar-grid screen
   * for steps to fill.
   */
  async report(userId: string, days: number): Promise<StepsReport> {
    const to = todayUtc();
    const from = shiftDays(to, -(days - 1));

    const rows = await this.db
      .select({ date: schema.stepLogs.measuredOn, steps: schema.stepLogs.steps })
      .from(schema.stepLogs)
      .where(
        and(
          eq(schema.stepLogs.userId, userId),
          gte(schema.stepLogs.measuredOn, from),
          lte(schema.stepLogs.measuredOn, to),
        ),
      );

    const byDate = new Map(rows.map((r) => [r.date, r.steps]));
    const points: StepPoint[] = [];
    for (let d = from; d <= to; d = shiftDays(d, 1)) {
      const steps = byDate.get(d);
      points.push({ date: d, steps: steps ?? 0, logged: steps !== undefined });
    }

    const logged = points.filter((p) => p.logged);
    const totalSteps = logged.reduce((sum, p) => sum + p.steps, 0);
    const bestDay = logged.reduce<StepPoint | null>(
      (best, p) => (best === null || p.steps > best.steps ? p : best),
      null,
    );

    return {
      from,
      to,
      days: points,
      totalSteps,
      averageSteps: logged.length === 0 ? 0 : totalSteps / logged.length,
      loggedDays: logged.length,
      bestDay,
    };
  }

  /** Record a day's steps. A second write for the same day corrects it. */
  async log(userId: string, input: LogSteps, days: number): Promise<StepsReport> {
    const measuredOn = input.date ?? todayUtc();

    await this.db
      .insert(schema.stepLogs)
      .values({ userId, measuredOn, steps: input.steps })
      .onConflictDoUpdate({
        target: [schema.stepLogs.userId, schema.stepLogs.measuredOn],
        set: { steps: input.steps, createdAt: new Date() },
      });

    return this.report(userId, days);
  }

  /** Delete one day's reading. 404 rather than a silent no-op on a day with nothing recorded. */
  async remove(userId: string, date: string, days: number): Promise<StepsReport> {
    const [row] = await this.db
      .select({ id: schema.stepLogs.id })
      .from(schema.stepLogs)
      .where(and(eq(schema.stepLogs.userId, userId), eq(schema.stepLogs.measuredOn, date)))
      .limit(1);

    if (!row) throw new NotFoundProblem('Step reading');

    await this.db.delete(schema.stepLogs).where(eq(schema.stepLogs.id, row.id));

    return this.report(userId, days);
  }
}

const MS_PER_DAY = 86_400_000;

function shiftDays(date: string, by: number): string {
  return new Date(Date.parse(date) + by * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Server-side "today" in UTC, used only to bound the window.
 *
 * The client sends its own local date for the reading itself, same as
 * `WeightService` — this is a cutoff on a chart, where being a few hours out
 * at either end of the world costs nothing.
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
