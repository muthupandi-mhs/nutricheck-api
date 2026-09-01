-- One weight per label per food.
--
-- The index cannot go on first: 25 labels are duplicated today and 17 of those
-- carry conflicting weights, so this deduplicates before constraining.
--
-- Which row survives is decided rather than left to chance. `is_default` first,
-- because a default was chosen for a reason; then the LOWEST weight, which is
-- the conservative answer for a nutrition tracker — over-reporting a portion
-- inflates somebody's day silently, and the portion is editable either way.
-- `ctid` breaks a remaining tie so the statement is deterministic.
DELETE FROM "food_portions" p
USING "food_portions" keep
WHERE p."food_id" = keep."food_id"
  AND p."label" = keep."label"
  AND p."ctid" <> keep."ctid"
  AND (keep."is_default", -keep."grams", keep."ctid")
      > (p."is_default", -p."grams", p."ctid");
--> statement-breakpoint
CREATE UNIQUE INDEX "food_portions_food_label_uq" ON "food_portions" USING btree ("food_id","label");
