-- The weekly review is a sixth model call, and it needs its own step.
--
-- Additive, like 0010 and 0014: ADD VALUE appends, nothing is rewritten, and no
-- row moves. The order of this enum is not read by anything.
--
-- Cheapest of the navigation-triggered calls to bound, and worth saying why.
-- `ideas` fires whenever a tab is opened and its answer depends on the day, so
-- its cache turns over daily; this one is keyed on a window that has already
-- happened. A past week's figures cannot change, so its review is written once
-- and served from Redis every time afterwards. The volume that reaches a model
-- is therefore one call per user per week they actually look at, not one per
-- visit -- which is what makes putting it on the Insights tab affordable at
-- all.
--
-- It records like everything else, which is what keeps
-- RESOLVE_USER_DAILY_SPEND_USD a real ceiling for it.

ALTER TYPE "public"."ai_step" ADD VALUE 'review';
