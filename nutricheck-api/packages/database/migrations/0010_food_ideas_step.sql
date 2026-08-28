-- The food-ideas tab is a fourth model call, and it needs its own step.
--
-- Additive, like 0009: ADD VALUE appends, nothing is rewritten, and no row
-- moves. The order of this enum is not read by anything -- unlike
-- activity_level in 0008, whose order IS the scale -- so no BEFORE is needed.
--
-- Recording it matters more than the row count suggests. `ideas` is the first
-- model call the app makes because a TAB WAS OPENED rather than because
-- somebody asked a question, so it is the one whose volume can run away
-- quietly. Without this value those calls could not be written to ai_runs at
-- all, and they would be invisible to both cost attribution and the per-user
-- daily spend ceiling -- which is exactly the hole `insight` sat in until it
-- started recording.

ALTER TYPE "public"."ai_step" ADD VALUE 'ideas';
