import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { fiberStateEnum, foodSourceEnum } from './enums';

export const foods = pgTable(
  'foods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: foodSourceEnum('source').notNull(),
    /** Stable id within the source. Together with `source`, the ingest upsert key. */
    sourceId: text('source_id').notNull(),
    name: text('name').notNull(),
    brand: text('brand'),
    /**
     * Generic rows (USDA) outrank branded ones (OFF) in search — the branded
     * corpus outnumbers the generic roughly fifty to one, so without the boost
     * "chicken thigh" surfaces a supermarket ready-meal.
     */
    isGeneric: boolean('is_generic').default(false).notNull(),
    searchText: text('search_text').notNull(),
    /**
     * Owner of a custom food. NULL for every corpus row.
     *
     * Without this a food created by one user is visible in everyone's search:
     * source='user' says how the row got here, not who it belongs to. Search
     * filters on (created_by IS NULL OR created_by = :userId).
     */
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('foods_source_source_id_uq').on(t.source, t.sourceId),
    index('foods_search_text_trgm_idx').using('gin', sql`${t.searchText} gin_trgm_ops`),
    index('foods_is_generic_idx').on(t.isGeneric),
    index('foods_created_by_idx').on(t.createdByUserId),
  ],
);

export const foodNutrients = pgTable('food_nutrients', {
  foodId: uuid('food_id')
    .primaryKey()
    .references(() => foods.id, { onDelete: 'cascade' }),
  /** All values per 100 g. Every displayed number is (value * grams / 100). */
  kcal: doublePrecision('kcal').notNull(),
  proteinG: doublePrecision('protein_g').notNull(),
  /**
   * NULL is a real state on each of these, not a missing zero — always paired
   * with the state column beside it. Measured against the corpus: SR Legacy
   * reports carbs and fat for 100% of its rows and fibre for 92.8%, so in
   * practice only fibre is often unknown. Curated dishes are estimates and
   * arrive 'imputed' across all three.
   */
  carbsG: doublePrecision('carbs_g'),
  carbsState: fiberStateEnum('carbs_state').notNull().default('unknown'),
  fatG: doublePrecision('fat_g'),
  fatState: fiberStateEnum('fat_state').notNull().default('unknown'),
  fiberG: doublePrecision('fiber_g'),
  fiberState: fiberStateEnum('fiber_state').notNull(),
});

export const foodPortions = pgTable(
  'food_portions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'cascade' }),
    /** "1 medium apple", "1 cup, cooked" — mapped from FNDDS at ingest, not query time. */
    label: text('label').notNull(),
    grams: doublePrecision('grams').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
  },
  (t) => [
    index('food_portions_food_id_idx').on(t.foodId),
    /**
     * One weight per label per food.
     *
     * Its absence was not theoretical. The AI-meal path writes a portion on
     * every mention with `onConflictDoNothing()`, and with nothing to conflict
     * on, "do nothing" never fired: each mention inserted another row, and the
     * same label accumulated different weights. "2 eggs" ended up stored as
     * both 100 g and 136 g on one food, and which one a portion resolved to
     * depended on the order the planner happened to return them in — so the
     * same sentence could total differently on different days.
     */
    uniqueIndex('food_portions_food_label_uq').on(t.foodId, t.label),
  ],
);

/**
 * Generic corpus only — roughly 40k rows, a ~60MB HNSW index that stays resident.
 * The ~2M branded OFF rows are reached by barcode or near-exact brand name, which
 * is a trigram query. Embedding them would buy a multi-gigabyte index for queries
 * that never needed it.
 */
export const foodEmbeddings = pgTable(
  'food_embeddings',
  {
    foodId: uuid('food_id')
      .primaryKey()
      .references(() => foods.id, { onDelete: 'cascade' }),
    embedding: vector('embedding', { dimensions: 384 }).notNull(),
    /** Pinned model identity. Changing it invalidates every row here. */
    modelVersion: text('model_version').notNull(),
  },
  (t) => [
    index('food_embeddings_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
);

export const foodBarcodes = pgTable(
  'food_barcodes',
  {
    gtin: text('gtin').primaryKey(),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'cascade' }),
  },
  (t) => [index('food_barcodes_food_id_idx').on(t.foodId)],
);

/**
 * Alternate names for a food.
 *
 * One dish, many spellings: "தோசை", "dosai", "dosa", "thosai". Folding them
 * into `foods.search_text` would work, but curating an alias would then mean
 * re-ingesting the row — and aliases are exactly the thing you edit weekly from
 * the miss log. A separate table with its own trigram index keeps that an
 * insert.
 *
 * `locale` is advisory. It records where a name comes from so the curation
 * queue can be filtered by language; search does not restrict on it, because a
 * Tamil speaker typing English should still find the dish.
 */
export const foodAliases = pgTable(
  'food_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'cascade' }),
    /** Normalized at write time by the same function the query uses. */
    alias: text('alias').notNull(),
    /** BCP-47-ish: 'ta' Tamil script, 'ta-Latn' Tanglish, 'en' English. */
    locale: text('locale').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('food_aliases_food_alias_uq').on(t.foodId, t.alias),
    index('food_aliases_trgm_idx').using('gin', sql`${t.alias} gin_trgm_ops`),
    index('food_aliases_food_id_idx').on(t.foodId),
  ],
);
