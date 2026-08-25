SET lock_timeout = '3s';
SET statement_timeout = '5min';
--> statement-breakpoint
-- Both statements below take an ACCESS EXCLUSIVE lock and scan the table. That
-- is acceptable only because `users` is empty in every environment at this
-- point. Note that CREATE INDEX CONCURRENTLY is NOT an option here: drizzle
-- runs each migration inside a transaction and CONCURRENTLY cannot. Once this
-- table has rows, an index like this has to be applied out-of-band instead.
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");