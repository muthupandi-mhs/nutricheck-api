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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('foods_source_source_id_uq').on(t.source, t.sourceId),
    index('foods_search_text_trgm_idx').using('gin', sql`${t.searchText} gin_trgm_ops`),
    index('foods_is_generic_idx').on(t.isGeneric),
  ],
);

export const foodNutrients = pgTable('food_nutrients', {
  foodId: uuid('food_id')
    .primaryKey()
    .references(() => foods.id, { onDelete: 'cascade' }),
  /** All values per 100 g. Every displayed number is (value * grams / 100). */
  kcal: doublePrecision('kcal').notNull(),
  proteinG: doublePrecision('protein_g').notNull(),
  /** NULL is a real state, not a missing zero. Paired with fiberState below. */
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
  (t) => [index('food_portions_food_id_idx').on(t.foodId)],
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
