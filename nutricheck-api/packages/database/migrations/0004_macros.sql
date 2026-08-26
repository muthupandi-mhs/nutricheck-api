-- Carbohydrate and fat, alongside the calories/protein/fibre the tracker
-- started with.
--
-- Three things worth knowing about this migration:
--
-- 1. The new value columns are NULLABLE and each is paired with a state column,
--    exactly as fibre already is. NULL means "we do not know", never zero —
--    the same invariant that keeps an unmeasured fibre out of the day's
--    denominator instead of silently under-reporting it.
--
-- 2. Existing rows default to 'unknown'. That is the honest state for every row
--    written before this: nobody measured their carbs. Re-running the USDA
--    ingest fills them in (SR Legacy reports both for 100% of its rows), and
--    the curated files carry estimates that arrive as 'imputed'.
--
-- 3. `log_items` gets them too, because nutrients are FROZEN at commit. History
--    is served verbatim and a USDA reissue must not rewrite a Tuesday in March,
--    so a logged item keeps its own copy rather than joining back to the food.
--    Rows written before today therefore stay 'unknown' forever, which is
--    correct — we genuinely do not know what those meals contained.

ALTER TABLE "food_nutrients"
  ADD COLUMN "carbs_g" double precision,
  ADD COLUMN "carbs_state" "fiber_state" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "fat_g" double precision,
  ADD COLUMN "fat_state" "fiber_state" NOT NULL DEFAULT 'unknown';

ALTER TABLE "log_items"
  ADD COLUMN "carbs_g" double precision,
  ADD COLUMN "carbs_state" "fiber_state" NOT NULL DEFAULT 'unknown',
  ADD COLUMN "fat_g" double precision,
  ADD COLUMN "fat_state" "fiber_state" NOT NULL DEFAULT 'unknown';

-- Goals are NOT NULL with a zero default: a target of zero reads as "no target
-- set", and every goal written from here on carries real numbers from the
-- calculator. Existing goals keep working untouched rather than being
-- back-filled with a split nobody chose.
ALTER TABLE "goals"
  ADD COLUMN "carbs_g" integer NOT NULL DEFAULT 0,
  ADD COLUMN "fat_g" integer NOT NULL DEFAULT 0;

-- The pairing above is an invariant, not a convention, so the database is where
-- it gets enforced. Without these a bad writer could store 'known' with a NULL
-- value and every consumer downstream would have to re-check what the schema
-- already claimed.
ALTER TABLE "food_nutrients"
  ADD CONSTRAINT "food_nutrients_carbs_state_matches_value"
    CHECK (("carbs_state" = 'unknown') = ("carbs_g" IS NULL)),
  ADD CONSTRAINT "food_nutrients_fat_state_matches_value"
    CHECK (("fat_state" = 'unknown') = ("fat_g" IS NULL));

ALTER TABLE "log_items"
  ADD CONSTRAINT "log_items_carbs_state_matches_value"
    CHECK (("carbs_state" = 'unknown') = ("carbs_g" IS NULL)),
  ADD CONSTRAINT "log_items_fat_state_matches_value"
    CHECK (("fat_state" = 'unknown') = ("fat_g" IS NULL));
