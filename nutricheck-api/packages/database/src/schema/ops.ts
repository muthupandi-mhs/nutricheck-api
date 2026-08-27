import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { aiMatchStatusEnum, aiStepEnum } from './enums';
import { foods } from './corpus';
import { users } from './identity';

/**
 * One row per model call. The spine of cost attribution, prompt-regression
 * analysis, and the eval set — and it is what makes any bad log replayable,
 * because the stored phrase IS the reproducible input.
 *
 * `response` is pruned to null after 30 days; the metrics on the row persist.
 */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    step: aiStepEnum('step').notNull(),
    /** sha256(normalizedPhrase + promptVersion + model) — the phrase-cache key. */
    inputHash: text('input_hash').notNull(),
    /** True when served from the phrase cache. Logged anyway so sampling stays honest. */
    cached: boolean('cached').default(false).notNull(),
    inputTokens: integer('input_tokens').default(0).notNull(),
    cacheReadTokens: integer('cache_read_tokens').default(0).notNull(),
    cacheWriteTokens: integer('cache_write_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    /** numeric, not float — these are summed per user for the spend ceiling. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
    latencyMs: integer('latency_ms').default(0).notNull(),
    stopReason: text('stop_reason'),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ai_runs_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('ai_runs_input_hash_idx').on(t.inputHash),
    index('ai_runs_created_brin_idx').on(t.createdAt),
  ],
);

/**
 * The curation queue. Every low-confidence match and every user correction lands
 * here with the EXACT words the user typed — searchable and groupable, which is
 * what makes "which dishes should we add next" a weekly query instead of a guess.
 */
export const matchMisses = pgTable(
  'match_misses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    phrase: text('phrase'),
    itemText: text('item_text').notNull(),
    /** Set when the user corrected it to a real food — the strongest signal here. */
    resolvedTo: uuid('resolved_to'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('match_misses_item_text_idx').on(t.itemText),
    index('match_misses_created_idx').on(t.createdAt.desc()),
  ],
);

/**
 * What the model thinks an unmatched name means, and whether users agreed.
 *
 * Deliberately NOT food_aliases. That table is human-authored and is what
 * search scores against; mixing model output into it makes "who wrote this"
 * unanswerable a month later, and a bad alias indistinguishable from a curated
 * one. This is a quarantine with an audit trail — the model writes here, users
 * vote, and only a promotion moves a mapping somewhere search can see it.
 *
 * The model proposes NAMES, never ids and never nutrients. Those names are run
 * back through the ordinary corpus search, so a hallucinated food simply
 * matches nothing and this row lands with a null foodId. That is the whole
 * safety property: the model cannot conjure a food into the corpus, it can only
 * fail to find one.
 */
export const aiFoodMatches = pgTable(
  'ai_food_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * normalizeSearchText(itemText) — the same normalization search uses, so
     * "Pavakkai", "pavakkai " and "PAVAKKAI" are one row. Unique, which is what
     * makes a name cost one model call once, ever: the second user asking hits
     * this row rather than the provider.
     */
    phrase: text('phrase').notNull(),
    /** Every name the model offered, verbatim. Kept even when none matched. */
    suggestions: jsonb('suggestions').notNull(),
    /**
     * The corpus row those suggestions actually found.
     *
     * NULL is the valuable state, not the failure one: the model understood the
     * word and we genuinely do not stock the food. That is the dish backlog
     * arriving as data, and it is a different problem from a food we hold under
     * a spelling nobody had written down yet.
     */
    foodId: uuid('food_id').references(() => foods.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** Evidence. The counts accumulate; status is the decision taken about them. */
    confirmations: integer('confirmations').default(0).notNull(),
    rejections: integer('rejections').default(0).notNull(),
    status: aiMatchStatusEnum('status').default('proposed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('ai_food_matches_phrase_uq').on(t.phrase),
    index('ai_food_matches_status_idx').on(t.status),
    index('ai_food_matches_food_idx').on(t.foodId),
  ],
);
