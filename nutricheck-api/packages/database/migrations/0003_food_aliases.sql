SET lock_timeout = '3s';
SET statement_timeout = '5min';
--> statement-breakpoint
CREATE TABLE "food_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"food_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "food_aliases" ADD CONSTRAINT "food_aliases_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "food_aliases_food_alias_uq" ON "food_aliases" USING btree ("food_id","alias");--> statement-breakpoint
CREATE INDEX "food_aliases_trgm_idx" ON "food_aliases" USING gin ("alias" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "food_aliases_food_id_idx" ON "food_aliases" USING btree ("food_id");