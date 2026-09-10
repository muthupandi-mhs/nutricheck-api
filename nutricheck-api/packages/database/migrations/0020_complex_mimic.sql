CREATE TABLE "featured_users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"added_by_admin_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"invite_code" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "featured_users" ADD CONSTRAINT "featured_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_users" ADD CONSTRAINT "featured_users_added_by_admin_id_admin_users_id_fk" FOREIGN KEY ("added_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_group_members" ADD CONSTRAINT "step_group_members_group_id_step_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."step_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_group_members" ADD CONSTRAINT "step_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_groups" ADD CONSTRAINT "step_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "step_group_members_group_user_uq" ON "step_group_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "step_group_members_user_idx" ON "step_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "step_groups_invite_code_uq" ON "step_groups" USING btree ("invite_code");