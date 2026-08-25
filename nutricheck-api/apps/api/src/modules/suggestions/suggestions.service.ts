import { Inject, Injectable } from '@nestjs/common';
import type { Suggestion } from '@nutricheck/contracts';
import { sql, type Database } from '@nutricheck/database';
import { DATABASE } from '../../infrastructure/database/database.tokens';

/**
 * The repeat strip.
 *
 * The most important flow in the app and the least interesting to build: one
 * tap, no confirm sheet, no model call, about two seconds. It is simultaneously
 * the retention feature and the margin — once the frequent-and-recent list is
 * good, the majority of logs stop costing an AI call at all.
 */

/**
 * Recency half-life in days. A food eaten daily last week should outrank one
 * eaten twice a month ago, but a long-standing staple should not vanish after a
 * quiet fortnight — hence a decay rather than a cutoff.
 */
const HALF_LIFE_DAYS = 10;

/**
 * How far either side of the current hour still counts as "this meal time".
 * Wide enough that an early or late eater is not punished, narrow enough that
 * porridge does not lead the strip at dinner.
 */
const HOUR_WINDOW = 3;

/** Applied to rows outside the window rather than excluding them, so the strip is never short. */
const OUT_OF_WINDOW_PENALTY = 0.35;

/**
 * Raw SQL through db.execute() bypasses Drizzle's result mapper, and its
 * node-postgres driver leaves timestamptz as a STRING rather than a Date — the
 * query builder does that conversion itself. Coerce at the boundary rather than
 * assuming a Date and crashing on .getTime().
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

interface FoodRow extends Record<string, unknown> {
  food_id: string;
  name: string;
  brand: string | null;
  kcal_per_100g: number;
  grams: number;
  last_logged_at: unknown;
  times_logged: number;
  /** Summed per-log time-of-day weight; divided by times_logged it is the mean. */
  hour_weight: number;
}

interface MealRow extends Record<string, unknown> {
  meal_id: string;
  name: string;
  item_count: number;
  kcal: number;
  last_logged_at: unknown;
  times_logged: number;
}

@Injectable()
export class SuggestionsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Foods and saved meals interleaved by score, because from the user's side
   * both are one tap and splitting them into two lists just adds a decision.
   */
  async recents(
    userId: string,
    limit: number,
    hour?: number,
  ): Promise<Suggestion[]> {
    const [foods, meals] = await Promise.all([
      this.recentFoods(userId, limit, hour),
      this.recentMeals(userId, limit),
    ]);

    const suggestions: Array<{ score: number; value: Suggestion }> = [];

    for (const row of foods) {
      const lastLoggedAt = toDate(row.last_logged_at);
      if (!lastLoggedAt) continue; // a logged food always has a timestamp

      suggestions.push({
        // The time-of-day weight has to be applied HERE. Using it only in the
        // SQL ORDER BY selects the right candidates and then throws the signal
        // away, which is exactly what it did before this line existed.
        score:
          scoreOf(row.times_logged, lastLoggedAt) *
          meanHourWeight(row.hour_weight, row.times_logged),
        value: {
          kind: 'food',
          food: {
            id: row.food_id,
            name: row.name,
            brand: row.brand,
            kcalPer100g: Number(row.kcal_per_100g),
          },
          // The portion they last used, so one tap needs no portion picker.
          grams: Number(row.grams),
          lastLoggedAt: lastLoggedAt.toISOString(),
          timesLogged: Number(row.times_logged),
        },
      });
    }

    for (const row of meals) {
      const lastLoggedAt = toDate(row.last_logged_at);
      suggestions.push({
        // A saved meal is a deliberate act, so it starts ahead of a food logged
        // the same number of times. A never-logged saved meal still surfaces.
        score: scoreOf(Number(row.times_logged) + 1, lastLoggedAt),
        value: {
          kind: 'meal',
          mealId: row.meal_id,
          name: row.name,
          itemCount: Number(row.item_count),
          kcal: Number(row.kcal),
          lastLoggedAt: lastLoggedAt?.toISOString() ?? null,
          timesLogged: Number(row.times_logged),
        },
      });
    }

    return suggestions
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.value);
  }

  private async recentFoods(userId: string, limit: number, hour?: number) {
    // Time-of-day scoring happens in SQL so the LIMIT is applied to the ranked
    // set rather than to an arbitrary slice that is then re-sorted in Node.
    const hourScore =
      hour === undefined
        ? sql`1.0`
        : sql`CASE WHEN LEAST(
                 ABS(EXTRACT(HOUR FROM le.logged_at) - ${hour}),
                 24 - ABS(EXTRACT(HOUR FROM le.logged_at) - ${hour})
               ) <= ${HOUR_WINDOW} THEN 1.0 ELSE ${OUT_OF_WINDOW_PENALTY} END`;

    const result = await this.db.execute<FoodRow>(sql`
      WITH scored AS (
        SELECT
          li.food_id,
          COUNT(*)                       AS times_logged,
          MAX(le.logged_at)              AS last_logged_at,
          SUM(${hourScore})              AS hour_weight,
          (array_agg(li.grams ORDER BY le.logged_at DESC))[1] AS grams
        FROM log_items li
        JOIN log_entries le ON le.id = li.entry_id
        WHERE le.user_id = ${userId}
        GROUP BY li.food_id
      )
      SELECT
        scored.food_id,
        f.name,
        f.brand,
        n.kcal AS kcal_per_100g,
        scored.grams,
        scored.last_logged_at,
        scored.times_logged,
        scored.hour_weight
      FROM scored
      JOIN foods f ON f.id = scored.food_id
      JOIN food_nutrients n ON n.food_id = f.id
      ORDER BY scored.hour_weight DESC, scored.last_logged_at DESC
      LIMIT ${limit * 2}
    `);

    return result.rows;
  }

  private async recentMeals(userId: string, limit: number) {
    const result = await this.db.execute<MealRow>(sql`
      SELECT
        m.id                                     AS meal_id,
        m.name,
        COUNT(mi.id)                             AS item_count,
        COALESCE(SUM(n.kcal * mi.grams / 100), 0) AS kcal,
        (
          SELECT MAX(le.logged_at)
          FROM log_entries le
          WHERE le.user_id = ${userId} AND le.source = 'repeat'
        )                                        AS last_logged_at,
        0                                        AS times_logged
      FROM meals m
      JOIN meal_items mi ON mi.meal_id = m.id
      JOIN food_nutrients n ON n.food_id = mi.food_id
      WHERE m.user_id = ${userId}
      GROUP BY m.id, m.name
      ORDER BY m.created_at DESC
      LIMIT ${limit}
    `);

    return result.rows;
  }
}

/**
 * Frequency x recency.
 *
 * log(count) rather than count so a food eaten 40 times does not permanently
 * own the strip over one eaten 8 times last night; exponential decay on recency
 * so the list turns over as habits change.
 */
/**
 * Mean per-log time-of-day weight, in [OUT_OF_WINDOW_PENALTY, 1].
 *
 * A food eaten every morning scores near 1 at breakfast and near the penalty at
 * dinner; one eaten at all hours sits in between and is barely affected, which
 * is the correct treatment for a staple.
 */
function meanHourWeight(hourWeight: number, timesLogged: number): number {
  const times = Number(timesLogged);
  if (!times) return 1;
  return Number(hourWeight) / times;
}

function scoreOf(timesLogged: number, lastLoggedAt: Date | null): number {
  const frequency = Math.log1p(timesLogged);
  if (!lastLoggedAt) return frequency * 0.5;

  const days = (Date.now() - lastLoggedAt.getTime()) / 86_400_000;
  const recency = Math.pow(0.5, days / HALF_LIFE_DAYS);
  return frequency * recency;
}
