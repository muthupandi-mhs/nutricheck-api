-- The assistant in the microphone sheet is a fifth model call, and it needs its
-- own step.
--
-- Additive, like 0010: ADD VALUE appends, nothing is rewritten, and no row
-- moves. The order of this enum is not read by anything.
--
-- This one matters more than the others for the ceiling it sits under. Every
-- other call in the app is provoked by an action with an obvious end -- a meal
-- said, a tab opened -- and a conversation is not: somebody can ask five
-- questions in a minute, each one a full model call. Without this value those
-- calls could not be written to ai_runs at all, so they would count against
-- neither cost attribution nor RESOLVE_USER_DAILY_SPEND_USD, and the one route
-- with no natural stopping point would be the one route with no ceiling.

ALTER TYPE "public"."ai_step" ADD VALUE 'chat';
