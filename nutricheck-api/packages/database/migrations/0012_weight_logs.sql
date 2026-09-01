CREATE TABLE "weight_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"measured_on" date NOT NULL,
	"weight_kg" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weight_logs" ADD CONSTRAINT "weight_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weight_logs_user_date_uq" ON "weight_logs" USING btree ("user_id","measured_on");--> statement-breakpoint
-- Seed the history from the weight every existing profile already holds.
--
-- Without this, an account that has been running for months opens the weight
-- screen to an empty chart and a "nothing logged yet" — which is false: there
-- IS a weight, it simply predates the table. `updated_at` is the closest honest
-- date for it. `ON CONFLICT DO NOTHING` makes the migration safe to re-run.
INSERT INTO "weight_logs" ("user_id", "measured_on", "weight_kg", "created_at")
SELECT "user_id", ("updated_at" AT TIME ZONE 'UTC')::date, "weight_kg", "updated_at"
FROM "user_profiles"
ON CONFLICT ("user_id", "measured_on") DO NOTHING;
