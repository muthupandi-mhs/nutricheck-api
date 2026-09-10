CREATE TYPE "public"."step_campaign_scope" AS ENUM('all', 'group');--> statement-breakpoint
CREATE TABLE "step_campaign" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"scope" "step_campaign_scope" NOT NULL,
	"group_id" uuid,
	"goal_steps" integer NOT NULL,
	"title" text,
	"tagline" text,
	"updated_by_admin_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "step_campaign" ADD CONSTRAINT "step_campaign_group_id_step_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."step_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_campaign" ADD CONSTRAINT "step_campaign_updated_by_admin_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;