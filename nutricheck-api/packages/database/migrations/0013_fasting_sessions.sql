CREATE TABLE "fasting_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"target_hours" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fasting_sessions_span_ck" CHECK ("fasting_sessions"."ended_at" is null or "fasting_sessions"."ended_at" > "fasting_sessions"."started_at")
);
--> statement-breakpoint
ALTER TABLE "fasting_sessions" ADD CONSTRAINT "fasting_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fasting_sessions_open_uq" ON "fasting_sessions" USING btree ("user_id") WHERE "fasting_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "fasting_sessions_user_started_idx" ON "fasting_sessions" USING btree ("user_id","started_at" DESC NULLS LAST);