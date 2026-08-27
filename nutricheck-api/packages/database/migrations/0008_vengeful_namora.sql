-- Six activity levels: 'active' comes back and 'athlete' joins it.
--
-- The counterpart to 0007, which removed 'active' one migration ago. Adding is
-- the cheap direction and dropping is the expensive one -- ADD VALUE against a
-- rebuild of the type and a data migration -- which is the whole reason the two
-- do not look alike.
--
-- 0007 folded everyone on 'active' into 'moderate'. Putting the value back does
-- not put those rows back; that information is gone. It never left this
-- machine, so what it cost was ten rows of local test data, but the same
-- sequence against staging would have cost real answers and there would have
-- been no undo.
--
-- BEFORE 'very_active' is not cosmetic. ADD VALUE appends by default, and the
-- enum's own order is what a plain ORDER BY on this column sorts on -- so
-- without it the scale would read sedentary, light, moderate, very_active,
-- athlete, active.

ALTER TYPE "public"."activity_level" ADD VALUE 'active' BEFORE 'very_active';--> statement-breakpoint
ALTER TYPE "public"."activity_level" ADD VALUE 'athlete';