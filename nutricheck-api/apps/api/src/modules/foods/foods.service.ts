import { Inject, Injectable } from '@nestjs/common';
import {
  normalizeSearchText,
  type CreateCustomFood,
  type FoodDetail,
  type FoodSearchResult,
  type FoodSummary,
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
 * How much of the rank comes from "is this row ABOUT the query" rather than
 * "does this row CONTAIN the query".
 *
 * `word_similarity` alone cannot discriminate at corpus scale: for "mango" it
 * returns exactly 1.000 for "Mangos, raw", "Babyfood, fruit dessert, mango with
 * tapioca" and "Beverages, V8 V-FUSION, Peach Mango" alike, because the query
 * appears verbatim in all three. With 13 fixture rows that was invisible; with
 * 8,000 it put babyfood at the top of every fruit search.
 *
 * `similarity()` compares the WHOLE string, so a short name that is mostly the
 * query scores far above a long compound name that merely contains it — 0.300
 * against 0.143 in that example. `word_similarity` stays the gate (does this
 * match at all); whole-string similarity orders what gets through.
 */
const WHOLE_STRING_WEIGHT = 0.45;

/**
 * Minimum blended score for a row to be returned at all.
 *
 * Without a floor, search always answers with the best of a bad set. Measured
 * on the real 8,000-row corpus: genuine matches score 1.06–1.14 while nonsense
 * scores 0.54–0.75, which is a clean separation. Below the floor these were
 * being returned as confident answers —
 *
 *   maggi         -> Topping, SMUCKER'S MAGIC SHELL   609 kcal
 *   murukku       -> Drumstick pods, raw               37 kcal
 *   paruppu usili -> Lentils, RAW                     352 kcal
 *
 * A miss is recoverable: the phrase lands in the scoped search box, the user
 * can create a custom food, and `match_misses` records the exact words so the
 * dish gets curated. A wrong number that looks plausible is not recoverable —
 * it is logged, frozen, and discovered a week later, which is the failure that
 * makes people delete a tracker.
 *
 * Returning nothing is the honest answer when there is nothing good to return.
 */
const MIN_SCORE = 0.95;

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

interface CandidateRow extends Record<string, unknown> {
  ord: number;
  id: string;
  name: string;
  brand: string | null;
  kcal_per_100g: number;
}

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
            GREATEST(
                word_similarity(${normalized}, f.search_text)
                  + ${sql.raw(String(WHOLE_STRING_WEIGHT))} * similarity(${normalized}, f.search_text),
                COALESCE((
                  SELECT MAX(
                    word_similarity(${normalized}, a.alias)
                      + ${sql.raw(String(WHOLE_STRING_WEIGHT))} * similarity(${normalized}, a.alias)
                  )
                  FROM food_aliases a WHERE a.food_id = f.id
                ), 0)
              )
              + CASE WHEN f.source = 'user' THEN ${BONUS_CUSTOM} ELSE 0.0 END
              + CASE WHEN logged.food_id IS NOT NULL THEN ${BONUS_LOGGED} ELSE 0.0 END
              + CASE WHEN f.is_generic THEN ${BONUS_GENERIC} ELSE 0.0 END
              AS rank
          FROM foods f
          JOIN food_nutrients n ON n.food_id = f.id
          LEFT JOIN logged ON logged.food_id = f.id
          -- A dish answers to its aliases as well as its name: "தோசை",
          -- "dosai" and "dosa" are one row. EXISTS rather than a join so a
          -- food with six aliases does not appear six times.
          WHERE (
              f.search_text %> ${normalized}
              OR EXISTS (
                SELECT 1 FROM food_aliases a
                WHERE a.food_id = f.id AND a.alias %> ${normalized}
              )
            )
            -- Corpus rows are owned by nobody; a custom food belongs to exactly
            -- one user. Without this filter one person's "Mum's dal" shows up
            -- in every other account's search.
            AND (f.created_by_user_id IS NULL OR f.created_by_user_id = ${userId})
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
        -- Below this, "no match" is the honest answer. See MIN_SCORE.
        WHERE ranked.rank >= ${sql.raw(String(MIN_SCORE))}
        ORDER BY ranked.rank DESC, ranked.name ASC
        LIMIT ${limit}
      `);

      return result.rows.map(toSearchResult);
    });
  }

/**
   * Candidate search for the resolver: all N item phrases in ONE query.
   *
   * A three-item meal issuing three round trips is 200ms instead of 40ms, and
   * it compounds on the five-item meals that are the whole argument for
   * parsing. The LATERAL join ranks each phrase independently against the same
   * index, so this costs one plan and one round trip regardless of N.
   */
  async searchMany(
    userId: string,
    phrases: string[],
    perPhrase = 8,
  ): Promise<Map<number, FoodSummary[]>> {
    const normalized = phrases.map(normalizeQuery);
    const byIndex = new Map<number, FoodSummary[]>();
    phrases.forEach((_, index) => byIndex.set(index, []));

    const usable = normalized.filter((p) => p.length > 0);
    if (usable.length === 0) return byIndex;

    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SET LOCAL pg_trgm.word_similarity_threshold = ${sql.raw(
          String(WORD_SIMILARITY_THRESHOLD),
        )}`,
      );

      const result = await tx.execute<CandidateRow>(sql`
        WITH phrases AS (
          -- Bound as a single JSON parameter, not as a JS array: Drizzle's sql
          -- template expands an array into a parameter LIST (the shape IN (...)
          -- wants), which Postgres then rejects as a malformed array literal.
          SELECT value AS phrase, ordinality AS ord
          FROM json_array_elements_text(${JSON.stringify(normalized)}::json)
            WITH ORDINALITY AS t(value, ordinality)
        ),
        logged AS (
          SELECT DISTINCT li.food_id
          FROM log_items li
          JOIN log_entries le ON le.id = li.entry_id
          WHERE le.user_id = ${userId}
        )
        SELECT ranked.ord, ranked.id, ranked.name, ranked.brand, ranked.kcal_per_100g
        FROM phrases
        CROSS JOIN LATERAL (
          SELECT
            phrases.ord,
            f.id,
            f.name,
            f.brand,
            n.kcal AS kcal_per_100g,
            GREATEST(
              word_similarity(phrases.phrase, f.search_text)
                + ${sql.raw(String(WHOLE_STRING_WEIGHT))} * similarity(phrases.phrase, f.search_text),
              COALESCE((
                SELECT MAX(
                  word_similarity(phrases.phrase, a.alias)
                    + ${sql.raw(String(WHOLE_STRING_WEIGHT))} * similarity(phrases.phrase, a.alias)
                )
                FROM food_aliases a WHERE a.food_id = f.id
              ), 0)
            )
              + CASE WHEN f.source = 'user' THEN ${BONUS_CUSTOM} ELSE 0.0 END
              + CASE WHEN logged.food_id IS NOT NULL THEN ${BONUS_LOGGED} ELSE 0.0 END
              + CASE WHEN f.is_generic THEN ${BONUS_GENERIC} ELSE 0.0 END AS rank
          FROM foods f
          JOIN food_nutrients n ON n.food_id = f.id
          LEFT JOIN logged ON logged.food_id = f.id
          WHERE (
              f.search_text %> phrases.phrase
              OR EXISTS (
                SELECT 1 FROM food_aliases a
                WHERE a.food_id = f.id AND a.alias %> phrases.phrase
              )
            )
            AND (f.created_by_user_id IS NULL OR f.created_by_user_id = ${userId})
          ORDER BY rank DESC, f.name ASC
          LIMIT ${perPhrase}
        ) AS ranked
        -- Same floor as single-phrase search, and it matters more here: these
        -- are the only rows the re-rank may choose from, and it is instructed
        -- to pick the closest even when none is right. Feeding it implausible
        -- candidates is how "murukku" becomes drumstick pods with a straight
        -- face. Returning fewer candidates than asked for is correct; returning
        -- none sends the words to the miss log, which is where they belong.
        WHERE ranked.rank >= ${sql.raw(String(MIN_SCORE))}
      `);

      for (const row of result.rows) {
        // WITH ORDINALITY is 1-based; the caller thinks in array indices.
        const index = Number(row.ord) - 1;
        byIndex.get(index)?.push({
          id: row.id,
          name: row.name,
          brand: row.brand,
          kcalPer100g: Number(row.kcal_per_100g),
        });
      }
    });

    return byIndex;
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

  /**
   * Create a custom food.
   *
   * Two fields and reusable afterwards: this is where a user lands when the
   * corpus has nothing (USER-FLOWS §8), and losing that entry would mean asking
   * them to re-type it every time they eat it.
   */
  async createCustom(userId: string, input: CreateCustomFood): Promise<FoodDetail> {
    const id = await this.db.transaction(async (tx) => {
      const [food] = await tx
        .insert(schema.foods)
        .values({
          source: 'user',
          // Unique within (source, source_id); a per-user namespace keeps two
          // people naming the same dish from colliding on the upsert key.
          sourceId: `${userId}:${input.name.trim().toLowerCase()}`,
          name: input.name.trim(),
          brand: input.brand,
          isGeneric: false,
          searchText: normalizeSearchText(input.name, input.brand),
          createdByUserId: userId,
        })
        .returning({ id: schema.foods.id });

      await tx.insert(schema.foodNutrients).values({
        foodId: food!.id,
        kcal: input.per100g.kcal,
        proteinG: input.per100g.proteinG,
        // The user is the source here, so a value they entered is 'known' and a
        // value they left blank stays unknown rather than becoming zero.
        fiberG: input.per100g.fiberState === 'unknown' ? null : input.per100g.fiberG,
        fiberState: input.per100g.fiberState,
      });

      if (input.defaultPortionGrams) {
        await tx.insert(schema.foodPortions).values({
          foodId: food!.id,
          label: '1 serving',
          grams: input.defaultPortionGrams,
          isDefault: true,
        });
      }

      return food!.id;
    });

    return this.findById(id);
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
 * Delegates to the shared normalizer in @nutricheck/contracts.
 *
 * The ingest uses the same function. A local reimplementation drifted once
 * already — it stripped every non-Latin character, so a Tamil query normalized
 * to the empty string and could never match anything.
 */
function normalizeQuery(query: string): string {
  return normalizeSearchText(query);
}
