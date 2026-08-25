import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { aiStepEnum } from './enums';
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
