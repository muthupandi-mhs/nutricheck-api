SET lock_timeout = '3s';
SET statement_timeout = '5min';
--> statement-breakpoint
-- Nullable column with no default and no backfill: ADD COLUMN is metadata-only
-- in Postgres 11+, so this does not rewrite the table even once foods has
-- millions of rows.
ALTER TABLE "foods" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
CREATE INDEX "foods_created_by_idx" ON "foods" USING btree ("created_by_user_id");