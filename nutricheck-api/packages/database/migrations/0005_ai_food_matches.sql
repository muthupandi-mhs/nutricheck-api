CREATE TYPE "public"."ai_match_status" AS ENUM('proposed', 'confirmed', 'rejected', 'promoted');--> statement-breakpoint
ALTER TYPE "public"."ai_step" ADD VALUE 'insight';--> statement-breakpoint
ALTER TYPE "public"."ai_step" ADD VALUE 'identify';--> statement-breakpoint
CREATE TABLE "ai_food_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase" text NOT NULL,
	"suggestions" jsonb NOT NULL,
	"food_id" uuid,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"rejections" integer DEFAULT 0 NOT NULL,
	"status" "ai_match_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_food_matches" ADD CONSTRAINT "ai_food_matches_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_food_matches_phrase_uq" ON "ai_food_matches" USING btree ("phrase");--> statement-breakpoint
CREATE INDEX "ai_food_matches_status_idx" ON "ai_food_matches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_food_matches_food_idx" ON "ai_food_matches" USING btree ("food_id");
