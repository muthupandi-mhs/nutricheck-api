import { Inject, Injectable } from '@nestjs/common';
import type {
  FoodDetail,
  FoodSearchResult,
  FoodSummary,
} from '@nutricheck/contracts';
import { schema, sql, type Database } from '@nutricheck/database';
import { NotFoundProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';

/**
 * Word-similarity, not plain similarity.
 *
 * `similarity()` compares trigram sets over the WHOLE string, so a one-word
 * query against a USDA description like "Chicken, broiler or fryers, breast,
 * skinless, boneless, meat only, raw" scores near zero — the query is a tiny
 * fraction of the target's trigrams. `word_similarity()` scores the query
 * against the best-matching extent within the target, which is exactly the
 * shape of this problem. The `%>` operator is its index-accelerated form and is
 * supported by the GIN gin_trgm_ops index on foods.search_text.
 */
const WORD_SIMILARITY_THRESHOLD = 0.45;

/**
 * Additive rank bonuses. Small enough that a clearly better text match wins.
 *
 * Inlined as SQL literals rather than bound parameters: inside
 * `CASE WHEN ... THEN $n ELSE 0 END` Postgres infers the parameter's type from
 * the integer `0` branch and rejects 0.3 with "invalid input syntax for type
 * integer". These are compile-time constants, so there is nothing to bind.
 */
const BONUS_CUSTOM = sql.raw('0.30');
const BONUS_LOGGED = sql.raw('0.15');
const BONUS_GENERIC = sql.raw('0.05');

interface SearchRow extends Record<string, unknown> {
  id: string;
  name: string;
  brand: string | null;
  kcal: number;
  protein_g: number;
  familiarity: 'custom' | 'logged' | 'none';
  portion_label: string | null;
  portion_grams: number | null;
}

@Injectable()
export class FoodsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Same code path as stage 3 of the resolver, so search quality and resolver
   * quality improve together rather than drifting apart.
   *
   * Runs in a transaction purely to scope `SET LOCAL` — the word-similarity
   * threshold is set per statement rather than inherited from a database-level
   * GUC, so behaviour is identical on a developer machine, in Testcontainers,
   * and in production regardless of how the server was provisioned.
   */
  async search(
    userId: string,
    query: string,
    limit: number,
  ): Promise<FoodSearchResult[]> {
    const normalized = normalizeQuery(query);
    if (normalized.length === 0) return [];

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SET LOCAL pg_trgm.word_similarity_threshold = ${sql.raw(
          String(WORD_SIMILARITY_THRESHOLD),
        )}`,
      );

      const result = await tx.execute<SearchRow>(sql`
        WITH logged AS (
          SELECT DISTINCT li.food_id
          FROM log_items li
          JOIN log_entries le ON le.id = li.entry_id
          WHERE le.user_id = ${userId}
        ),
        ranked AS (
          SELECT
            f.id,
            f.name,
            f.brand,
            n.kcal,
            n.protein_g,
            CASE
              WHEN f.source = 'user' THEN 'custom'
              WHEN logged.food_id IS NOT NULL THEN 'logged'
              ELSE 'none'
            END AS familiarity,
            word_similarity(${normalized}, f.search_text)
              + CASE WHEN f.source = 'user' THEN ${BONUS_CUSTOM} ELSE 0.0 END
              + CASE WHEN logged.food_id IS NOT NULL THEN ${BONUS_LOGGED} ELSE 0.0 END
              + CASE WHEN f.is_generic THEN ${BONUS_GENERIC} ELSE 0.0 END
              AS rank
          FROM foods f
          JOIN food_nutrients n ON n.food_id = f.id
          LEFT JOIN logged ON logged.food_id = f.id
          WHERE f.search_text %> ${normalized}
        )
        SELECT
          ranked.*,
          p.label AS portion_label,
          p.grams AS portion_grams
        FROM ranked
        LEFT JOIN LATERAL (
          SELECT label, grams
          FROM food_portions
          WHERE food_id = ranked.id
          ORDER BY is_default DESC
          LIMIT 1
        ) p ON TRUE
        ORDER BY ranked.rank DESC, ranked.name ASC
        LIMIT ${limit}
      `);

      return result.rows.map(toSearchResult);
    });
  }

  async findById(id: string): Promise<FoodDetail> {
    const [row] = await this.db
      .select({
        id: schema.foods.id,
        name: schema.foods.name,
        brand: schema.foods.brand,
        source: schema.foods.source,
        isGeneric: schema.foods.isGeneric,
        kcal: schema.foodNutrients.kcal,
        proteinG: schema.foodNutrients.proteinG,
        fiberG: schema.foodNutrients.fiberG,
        fiberState: schema.foodNutrients.fiberState,
      })
      .from(schema.foods)
      .innerJoin(
        schema.foodNutrients,
        sql`${schema.foodNutrients.foodId} = ${schema.foods.id}`,
      )
      .where(sql`${schema.foods.id} = ${id}`)
      .limit(1);

    if (!row) throw new NotFoundProblem('Food');

    const portions = await this.db
      .select({
        label: schema.foodPortions.label,
        grams: schema.foodPortions.grams,
        isDefault: schema.foodPortions.isDefault,
      })
      .from(schema.foodPortions)
      .where(sql`${schema.foodPortions.foodId} = ${id}`)
      .orderBy(sql`${schema.foodPortions.isDefault} DESC`);

    return {
      id: row.id,
      name: row.name,
      brand: row.brand,
      kcalPer100g: row.kcal,
      source: row.source,
      isGeneric: row.isGeneric,
      nutrients: {
        kcal: row.kcal,
        proteinG: row.proteinG,
        fiberG: row.fiberG,
        fiberState: row.fiberState,
      },
      portions,
    };
  }

  /** The compact projection the resolver serializes into the re-rank prompt. */
  toSummary(food: FoodDetail): FoodSummary {
    return {
      id: food.id,
      name: food.name,
      brand: food.brand,
      kcalPer100g: food.kcalPer100g,
    };
  }
}

function toSearchResult(row: SearchRow): FoodSearchResult {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    kcalPer100g: Number(row.kcal),
    proteinPer100g: Number(row.protein_g),
    familiarity: row.familiarity,
    defaultPortion:
      row.portion_label !== null && row.portion_grams !== null
        ? { label: row.portion_label, grams: Number(row.portion_grams), isDefault: true }
        : null,
  };
}

/**
 * Must match the normalization the ingest applied to `search_text`, or the
 * query compares against bytes the index was never built over.
 */
function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
