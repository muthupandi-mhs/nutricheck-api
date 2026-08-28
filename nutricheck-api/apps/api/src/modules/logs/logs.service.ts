import { Inject, Injectable } from '@nestjs/common';
import {
  type BatchCommitResult,
  type CommitLogEntry,
  type DaySummary,
  type LogEntry,
  type UpdateLogEntry,
  type UpdateLogItem,
  type DayPoint,
  type MonthSummary,
  type WeekSummary,
} from '@nutricheck/contracts';
import {
  and,
  asc,
  eq,
  inArray,
  schema,
  sql,
  type Database,
} from '@nutricheck/database';
import { NotFoundProblem, ProblemException } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { GoalsService } from '../goals/goals.service';
import { computeItemNutrients, sumDay } from './nutrition-calculator';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class LogsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly goals: GoalsService,
  ) {}

  /**
   * Commit an entry.
   *
   * Two rules live here and nowhere else:
   *
   *  1. The server recomputes every nutrient from food_nutrients. The request
   *     carries food_id and grams only — the client's numbers are for optimistic
   *     rendering and are never trusted, so two clients cannot disagree about
   *     what a Tuesday contained.
   *  2. Those computed values are FROZEN onto log_items. History is served
   *     verbatim afterwards, so a USDA reissue cannot silently rewrite March.
   */
  async commit(
    userId: string,
    input: CommitLogEntry,
  ): Promise<{ entry: LogEntry; created: boolean }> {
    const existing = await this.findByClientId(userId, input.clientId);
    if (existing) {
      // Idempotent replay of a drained offline queue. Returning the original is
      // the whole reason clientId is generated on-device before the request.
      return { entry: existing, created: false };
    }

    try {
      const entryId = await this.db.transaction(async (tx) => {
        const per100g = await this.loadNutrients(
          tx,
          input.items.map((i) => i.foodId),
        );

        const [entry] = await tx
          .insert(schema.logEntries)
          .values({
            clientId: input.clientId,
            userId,
            loggedAt: new Date(input.loggedAt),
            meal: input.meal,
            source: input.source,
            phrase: input.phrase,
          })
          .returning({ id: schema.logEntries.id });

        await tx.insert(schema.logItems).values(
          input.items.map((item) => {
            const source = per100g.get(item.foodId);
            if (!source) throw new NotFoundProblem(`Food ${item.foodId}`);

            const nutrients = computeItemNutrients(source, item.grams);
            return {
              entryId: entry!.id,
              foodId: item.foodId,
              grams: item.grams,
              kcal: nutrients.kcal,
              proteinG: nutrients.proteinG,
              carbsG: nutrients.carbsG,
              carbsState: nutrients.carbsState,
              fatG: nutrients.fatG,
              fatState: nutrients.fatState,
              fiberG: nutrients.fiberG,              fiberState: nutrients.fiberState,
              quantityType: item.quantityType,
              quantitySource: item.quantitySource,
            };
          }),
        );

        // Every correction is training data. Learning a personal unit belongs in
        // the commit transaction — as a separate request it is the write that
        // gets lost, and it is the one that makes the product improve with use.
        for (const item of input.items) {
          await this.learnPortion(tx, userId, item);
        }

        await this.rememberPhrase(tx, userId, input);

        return entry!.id;
      });

      return { entry: await this.getById(userId, entryId), created: true };
    } catch (error) {
      // Lost the race against a concurrent replay of the same clientId. The
      // unique index is the arbiter; a SELECT-then-INSERT check has a window.
      if (isUniqueViolation(error)) {
        const raced = await this.findByClientId(userId, input.clientId);
        if (raced) return { entry: raced, created: false };
      }
      throw error;
    }
  }

  /**
   * Record that a personal unit means this many grams for this food.
   *
   * Shared by commit and the per-item portion edit, because both are the same
   * act from the user's side: "no, a bowl is 180 g". A no-op without a label.
   */
  private async learnPortion(
    tx: Tx,
    userId: string,
    item: { foodId: string; grams: number; learnedUnitLabel: string | null },
  ): Promise<void> {
    if (!item.learnedUnitLabel) return;
    await tx
      .insert(schema.userPortions)
      .values({
        userId,
        unitLabel: item.learnedUnitLabel.trim().toLowerCase(),
        foodId: item.foodId,
        grams: item.grams,
      })
      .onConflictDoUpdate({
        target: [
          schema.userPortions.userId,
          schema.userPortions.unitLabel,
          schema.userPortions.foodId,
        ],
        set: {
          grams: item.grams,
          nCorrections: sql`${schema.userPortions.nCorrections} + 1`,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Drain an offline queue. Always 200 with per-element results: one bad entry
   * must not fail the other eleven.
   */
  async commitBatch(
    userId: string,
    entries: CommitLogEntry[],
  ): Promise<BatchCommitResult[]> {
    const results: BatchCommitResult[] = [];

    for (const input of entries) {
      try {
        const { entry, created } = await this.commit(userId, input);
        results.push({
          status: created ? 'created' : 'duplicate',
          clientId: input.clientId,
          entry,
        });
      } catch (error) {
        results.push({
          status: 'failed',
          clientId: input.clientId,
          problem:
            error instanceof ProblemException
              ? { title: error.problem.title, status: error.problem.status }
              : { title: 'Could not save this entry', status: 500 },
        });
      }
    }

    return results;
  }

  async getById(userId: string, entryId: string): Promise<LogEntry> {
    const [entry] = await this.db
      .select()
      .from(schema.logEntries)
      .where(and(eq(schema.logEntries.id, entryId), eq(schema.logEntries.userId, userId)))
      .limit(1);

    if (!entry) throw new NotFoundProblem('Log entry');
    const [withItems] = await this.loadItems([entry]);
    return withItems!;
  }

  /**
   * Edit a whole entry: the confirm sheet rewriting a meal, where items may be
   * added, removed or swapped and none of them has an id yet.
   *
   * Items are replaced wholesale, which is why this is NOT the route for a
   * portion tweak — see `updateItem`, which addresses one committed item by id
   * and keeps the correction as training data. Sending a whole entry back to
   * move one number loses that signal and clobbers concurrent edits.
   *
   * Nutrients are recomputed and re-frozen from the corpus exactly as on
   * commit, so an edited entry is indistinguishable from one committed
   * correctly the first time.
   */
  async update(
    userId: string,
    entryId: string,
    patch: UpdateLogEntry,
  ): Promise<LogEntry> {
    // Establishes ownership before anything is written.
    await this.getById(userId, entryId);

    await this.db.transaction(async (tx) => {
      if (patch.meal || patch.loggedAt) {
        await tx
          .update(schema.logEntries)
          .set({
            ...(patch.meal ? { meal: patch.meal } : {}),
            ...(patch.loggedAt ? { loggedAt: new Date(patch.loggedAt) } : {}),
          })
          .where(eq(schema.logEntries.id, entryId));
      }

      if (!patch.items) return;

      const per100g = await this.loadNutrients(
        tx,
        patch.items.map((i) => i.foodId),
      );

      await tx.delete(schema.logItems).where(eq(schema.logItems.entryId, entryId));

      await tx.insert(schema.logItems).values(
        patch.items.map((item) => {
          const source = per100g.get(item.foodId);
          if (!source) throw new NotFoundProblem(`Food ${item.foodId}`);

          const nutrients = computeItemNutrients(source, item.grams);
          return {
            entryId,
            foodId: item.foodId,
            grams: item.grams,
            kcal: nutrients.kcal,
            proteinG: nutrients.proteinG,
            carbsG: nutrients.carbsG,
            carbsState: nutrients.carbsState,
            fatG: nutrients.fatG,
            fatState: nutrients.fatState,
            fiberG: nutrients.fiberG,            fiberState: nutrients.fiberState,
            quantityType: item.quantityType,
            quantitySource: item.quantitySource,
          };
        }),
      );
    });

    return this.getById(userId, entryId);
  }

  /**
   * Change one item's portion, leaving its siblings untouched.
   *
   * The wholesale `update` above cannot serve this: to move one portion the
   * client would have to send every item back, and two edits racing on the
   * same entry would each overwrite the other's untouched items with a stale
   * copy. Addressing the item by id makes the write as narrow as the edit.
   *
   * `quantitySource` becomes `stated` because the user just stated it. That is
   * the whole point — the number is no longer an inference from a portion
   * table, and the day view should stop presenting it as one.
   */
  async updateItem(
    userId: string,
    entryId: string,
    itemId: string,
    patch: UpdateLogItem,
  ): Promise<LogEntry> {
    // Establishes ownership of the ENTRY before the item is touched. Without
    // this, a known item id would be editable across accounts.
    await this.getById(userId, entryId);

    await this.db.transaction(async (tx) => {
      const [item] = await tx
        .select({ id: schema.logItems.id, foodId: schema.logItems.foodId })
        .from(schema.logItems)
        .where(
          and(eq(schema.logItems.id, itemId), eq(schema.logItems.entryId, entryId)),
        )
        .limit(1);

      // Scoped to the entry as well as the id, so an item id from someone
      // else's entry is a 404 rather than a cross-entry edit.
      if (!item) throw new NotFoundProblem('Log item');

      const per100g = await this.loadNutrients(tx, [item.foodId]);
      const source = per100g.get(item.foodId);
      if (!source) throw new NotFoundProblem(`Food ${item.foodId}`);

      // Re-frozen from the corpus exactly as on commit. An edited item is
      // indistinguishable from one logged at this portion in the first place.
      const nutrients = computeItemNutrients(source, patch.grams);

      await tx
        .update(schema.logItems)
        .set({
          grams: patch.grams,
          kcal: nutrients.kcal,
          proteinG: nutrients.proteinG,
          carbsG: nutrients.carbsG,
          carbsState: nutrients.carbsState,
          fatG: nutrients.fatG,
          fatState: nutrients.fatState,
          fiberG: nutrients.fiberG,          fiberState: nutrients.fiberState,
          quantitySource: 'stated',
        })
        .where(eq(schema.logItems.id, itemId));

      await this.learnPortion(tx, userId, {
        foodId: item.foodId,
        grams: patch.grams,
        learnedUnitLabel: patch.learnedUnitLabel,
      });
    });

    return this.getById(userId, entryId);
  }

  /**
   * Remember the sentence that produced an entry, for the composer's
   * "say it again" strip.
   *
   * In the commit transaction rather than a route of its own: a phrase that
   * only gets recorded when a second request succeeds is a phrase that is
   * missing exactly when the connection was bad, which is when replaying one
   * matters most.
   *
   * Typed and spoken text both count, but a repeat-tap does not — it carries
   * no phrase, and counting it would let one sentence dominate the strip
   * without the user ever saying it again.
   */
  private async rememberPhrase(
    tx: Tx,
    userId: string,
    input: CommitLogEntry,
  ): Promise<void> {
    const phrase = input.phrase?.trim();
    if (!phrase) return;

    await tx
      .insert(schema.userPhrases)
      .values({ userId, phrase, useCount: 1, lastUsedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.userPhrases.userId, schema.userPhrases.phrase],
        set: {
          useCount: sql`${schema.userPhrases.useCount} + 1`,
          lastUsedAt: new Date(),
        },
      });
  }

  async remove(userId: string, entryId: string): Promise<void> {
    const deleted = await this.db
      .delete(schema.logEntries)
      .where(and(eq(schema.logEntries.id, entryId), eq(schema.logEntries.userId, userId)))
      .returning({ id: schema.logEntries.id });

    if (deleted.length === 0) throw new NotFoundProblem('Log entry');
  }

  /**
   * A day, bounded by the USER's timezone rather than UTC.
   *
   * A meal logged at 11pm in Chennai belongs to that day, not to the next one,
   * and the boundary is computed in Postgres so it uses the same tz database
   * the rest of the query does.
   */
  async day(userId: string, date: string, tz: string): Promise<DaySummary> {
    const entries = await this.db
      .select()
      .from(schema.logEntries)
      .where(
        and(
          eq(schema.logEntries.userId, userId),
          sql`(${schema.logEntries.loggedAt} AT TIME ZONE ${tz})::date = ${date}::date`,
        ),
      )
      .orderBy(asc(schema.logEntries.loggedAt));

    const withItems = await this.loadItems(entries);
    const totals = sumDay(withItems.flatMap((e) => e.items.map((i) => i.nutrients)));

    // The goal in effect on THAT date, never today's.
    const goal = await this.goals.goalInEffect(userId, date);

    return {
      date,
      totals,
      goal: goal
        ? { kcal: goal.kcal, proteinG: goal.proteinG, carbsG: goal.carbsG, fatG: goal.fatG, fiberG: goal.fiberG }
        : { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
      entries: withItems,
    };
  }

  private async findByClientId(
    userId: string,
    clientId: string,
  ): Promise<LogEntry | null> {
    const [entry] = await this.db
      .select()
      .from(schema.logEntries)
      .where(
        and(
          eq(schema.logEntries.userId, userId),
          eq(schema.logEntries.clientId, clientId),
        ),
      )
      .limit(1);

    if (!entry) return null;
    const [withItems] = await this.loadItems([entry]);
    return withItems ?? null;
  }

  /**
   * Seven days ending on `date`, for the insights tab.
   *
   * Aggregated in Postgres rather than by fetching a week of entries and
   * summing in Node: the day view needs every item to render a meal, and this
   * needs four numbers per day. Pulling the former to compute the latter is
   * the difference between four rows and four hundred.
   *
   * Day boundaries are the user's, computed the same way `day()` computes
   * them, so a bar on the chart contains exactly the entries the day view
   * would show for that date.
   */
  /**
   * A whole calendar month, one `DayPoint` per day.
   *
   * Shares `dayPointsBetween` with `week()` rather than running a second,
   * near-identical aggregate. The two differ only in the window and in what
   * they compute over the result, and duplicating the SQL would be duplicating
   * the unknown-handling — the `FILTER (WHERE state <> 'unknown')` clauses are
   * the subtle part, and a copy of them is a copy that can drift.
   */
  async month(userId: string, date: string, tz: string): Promise<MonthSummary> {
    const from = firstOfMonth(date);
    const to = lastOfMonth(date);

    const days = await this.dayPointsBetween(userId, from, to, tz);

    // The goal in effect at the END of the window, matching `week()`. See the
    // note on MonthSummary: per-day resolution is a lookup per cell.
    const goal = await this.goals.goalInEffect(userId, to);

    return {
      from,
      to,
      days,
      goal: goal
        ? { kcal: goal.kcal, proteinG: goal.proteinG, carbsG: goal.carbsG, fatG: goal.fatG, fiberG: goal.fiberG }
        : { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
      loggedDays: days.filter((d) => d.logged).length,
    };
  }

  async week(userId: string, date: string, tz: string): Promise<WeekSummary> {
    const from = addDays(date, -(WEEK_DAYS - 1));

    const days = await this.dayPointsBetween(userId, from, date, tz);

    const logged = days.filter((d) => d.logged);
    const mean = (pick: (d: DayPoint) => number) =>
      logged.length === 0
        ? 0
        : round2(logged.reduce((sum, d) => sum + pick(d), 0) / logged.length);

    // The goal in effect at the END of the window, not today's. A week viewed
    // in hindsight is measured against the target that was actually in force.
    const goal = await this.goals.goalInEffect(userId, date);

    return {
      from,
      to: date,
      days,
      goal: goal
        ? { kcal: goal.kcal, proteinG: goal.proteinG, carbsG: goal.carbsG, fatG: goal.fatG, fiberG: goal.fiberG }
        : { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
      averages: {
        kcal: mean((d) => d.kcal),
        proteinG: mean((d) => d.proteinG),
        carbsG: mean((d) => d.carbsG),
        fatG: mean((d) => d.fatG),
        fiberG: mean((d) => d.fiberG),
      },
      streakDays: await this.streak(userId, date, tz),
    };
  }

  /**
   * One `DayPoint` per day between `from` and `to` inclusive, gaps filled.
   *
   * Every day in the range is present whether or not it has data: a chart has a
   * bar per day and a calendar has a cell per day, and a missing row must
   * render as an empty one rather than shifting its neighbours along.
   */
  private async dayPointsBetween(
    userId: string,
    from: string,
    to: string,
    tz: string,
  ): Promise<DayPoint[]> {
    const result = await this.db.execute<WeekRow>(sql`
      SELECT
        (e.logged_at AT TIME ZONE ${tz})::date AS d,
        COUNT(DISTINCT e.id)                   AS entry_count,
        COALESCE(SUM(li.kcal), 0)              AS kcal,
        COALESCE(SUM(li.protein_g), 0)         AS protein_g,
        -- An unknown is excluded from its own sum, never counted as zero.
        -- Same rule as sumDay, applied per nutrient rather than shared.
        COALESCE(SUM(li.carbs_g) FILTER (
          WHERE li.carbs_state <> 'unknown' AND li.carbs_g IS NOT NULL
        ), 0)                                  AS carbs_g,
        COALESCE(SUM(li.fat_g) FILTER (
          WHERE li.fat_state <> 'unknown' AND li.fat_g IS NOT NULL
        ), 0)                                  AS fat_g,
        COALESCE(SUM(li.fiber_g) FILTER (
          WHERE li.fiber_state <> 'unknown' AND li.fiber_g IS NOT NULL
        ), 0)                                  AS fiber_g
      FROM log_entries e
      LEFT JOIN log_items li ON li.entry_id = e.id
      WHERE e.user_id = ${userId}
        AND (e.logged_at AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY d
    `);

    const byDate = new Map(
      result.rows.map((row) => [toLocalDate(row.d), row] as const),
    );

    const days: DayPoint[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const row = byDate.get(day);
      days.push({
        date: day,
        kcal: round2(Number(row?.kcal ?? 0)),
        proteinG: round2(Number(row?.protein_g ?? 0)),
        carbsG: round2(Number(row?.carbs_g ?? 0)),
        fatG: round2(Number(row?.fat_g ?? 0)),
        fiberG: round2(Number(row?.fiber_g ?? 0)),
        logged: Number(row?.entry_count ?? 0) > 0,
      });
    }

    return days;
  }

  /**
   * Consecutive logged days ending at `date`, counted in the user's zone and
   * NOT limited to the seven in the window.
   *
   * Gaps-and-islands in one query: number the distinct logged days backwards
   * from the anchor, and a day is part of the run exactly while its distance
   * from the anchor equals its row number. The moment a day is missing, the
   * distance runs permanently ahead of the row number and can never catch up,
   * so counting the matches counts the streak and stops at the first gap.
   *
   * Returns 0 when `date` itself has no entry. That is the literal reading of
   * "counting back from today", and it means the streak reads zero all morning
   * until the first log lands — a product question worth revisiting, not
   * something to paper over here.
   */
  private async streak(userId: string, date: string, tz: string): Promise<number> {
    const result = await this.db.execute<{ streak: number }>(sql`
      WITH logged_days AS (
        SELECT DISTINCT (e.logged_at AT TIME ZONE ${tz})::date AS d
        FROM log_entries e
        WHERE e.user_id = ${userId}
          AND (e.logged_at AT TIME ZONE ${tz})::date <= ${date}::date
      ),
      ranked AS (
        SELECT
          (${date}::date - d)                  AS distance,
          ROW_NUMBER() OVER (ORDER BY d DESC) - 1 AS rn
        FROM logged_days
      )
      SELECT COUNT(*) AS streak FROM ranked WHERE distance = rn
    `);

    return Number(result.rows[0]?.streak ?? 0);
  }

  private async loadNutrients(tx: Tx, foodIds: string[]) {
    const rows = await tx
      .select({
        foodId: schema.foodNutrients.foodId,
        kcal: schema.foodNutrients.kcal,
        proteinG: schema.foodNutrients.proteinG,
        carbsG: schema.foodNutrients.carbsG,
        carbsState: schema.foodNutrients.carbsState,
        fatG: schema.foodNutrients.fatG,
        fatState: schema.foodNutrients.fatState,
        fiberG: schema.foodNutrients.fiberG,        fiberState: schema.foodNutrients.fiberState,
      })
      .from(schema.foodNutrients)
      .where(inArray(schema.foodNutrients.foodId, foodIds));

    return new Map(rows.map((r) => [r.foodId, r]));
  }

  private async loadItems(
    entries: Array<typeof schema.logEntries.$inferSelect>,
  ): Promise<LogEntry[]> {
    if (entries.length === 0) return [];

    const items = await this.db
      .select({
        id: schema.logItems.id,
        entryId: schema.logItems.entryId,
        grams: schema.logItems.grams,
        kcal: schema.logItems.kcal,
        proteinG: schema.logItems.proteinG,
        carbsG: schema.logItems.carbsG,
        carbsState: schema.logItems.carbsState,
        fatG: schema.logItems.fatG,
        fatState: schema.logItems.fatState,
        fiberG: schema.logItems.fiberG,
        fiberState: schema.logItems.fiberState,
        quantityType: schema.logItems.quantityType,
        quantitySource: schema.logItems.quantitySource,
        foodId: schema.foods.id,
        foodName: schema.foods.name,
        foodBrand: schema.foods.brand,
        foodKcalPer100g: schema.foodNutrients.kcal,
      })
      .from(schema.logItems)
      .innerJoin(schema.foods, eq(schema.foods.id, schema.logItems.foodId))
      .innerJoin(
        schema.foodNutrients,
        eq(schema.foodNutrients.foodId, schema.foods.id),
      )
      .where(
        inArray(
          schema.logItems.entryId,
          entries.map((e) => e.id),
        ),
      );

    const byEntry = new Map<string, LogEntry['items']>();
    for (const item of items) {
      const list = byEntry.get(item.entryId) ?? [];
      list.push({
        id: item.id,
        food: {
          id: item.foodId,
          name: item.foodName,
          brand: item.foodBrand,
          kcalPer100g: item.foodKcalPer100g,
        },
        grams: item.grams,
        quantityType: item.quantityType,
        quantitySource: item.quantitySource,
        // Read back verbatim. NOT recomputed from food_nutrients — that is the
        // entire point of freezing them.
        nutrients: {
          kcal: item.kcal,
          proteinG: item.proteinG,
          carbsG: item.carbsG,
          carbsState: item.carbsState,
          fatG: item.fatG,
          fatState: item.fatState,
          fiberG: item.fiberG,
          fiberState: item.fiberState,
        },
      });
      byEntry.set(item.entryId, list);
    }

    return entries.map((entry) => ({
      id: entry.id,
      clientId: entry.clientId,
      loggedAt: entry.loggedAt.toISOString(),
      meal: entry.meal,
      source: entry.source,
      phrase: entry.phrase,
      items: byEntry.get(entry.id) ?? [],
    }));
  }
}

/** Postgres 23505 — unique_violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}


/** Seven days, including the anchor. */
const WEEK_DAYS = 7;

interface WeekRow extends Record<string, unknown> {
  d: unknown;
  entry_count: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
}

/**
 * Calendar-date arithmetic in UTC, never local.
 *
 * These strings are dates, not instants: a week runs Monday to Sunday whatever
 * the clocks did in between. Doing this with a local Date crosses a DST
 * boundary twice a year and silently produces a six- or eight-day week.
 */
function addDays(date: string, delta: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = Date.UTC(year!, month! - 1, day!) + delta * 86_400_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** First of the calendar month `date` falls in. Pure string work — no zone. */
export function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * Last of the calendar month `date` falls in.
 *
 * Day 0 of the NEXT month is the last of this one, which is how this avoids a
 * table of month lengths and gets February right in a leap year for free.
 */
export function lastOfMonth(date: string): string {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
}

/**
 * A `date` column through raw execute() arrives as a 'YYYY-MM-DD' string from
 * node-postgres, but a driver that hands back a Date must not silently key the
 * map on an ISO instant — that would miss every bucket and render an empty week.
 */
function toLocalDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
