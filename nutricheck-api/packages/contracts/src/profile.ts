import { z } from 'zod';
import { LocalDate } from './common';

export const Sex = z.enum(['male', 'female']);
export type Sex = z.infer<typeof Sex>;

/**
 * Plain-language activity levels, not multipliers. The user picks "Desk job,
 * little exercise" (USER-FLOWS §2); the factor is a server-side detail.
 */
export const ActivityLevel = z.enum([
  'sedentary',
  'light',
  'moderate',
  'active',
  'very_active',
  'athlete',
]);
export type ActivityLevel = z.infer<typeof ActivityLevel>;

export const Objective = z.enum(['lose', 'maintain', 'gain']);
export type Objective = z.infer<typeof Objective>;

/**
 * A display name. Trimmed before it is measured, so a field of spaces is empty
 * rather than 20 characters long, and capped well above any real name — the
 * bound is there to stop a paste of a novel reaching the database, not to
 * arbitrate what a name may be. No character class is enforced: every rule
 * anyone has ever written about the shape of a name is wrong somewhere.
 */
const NameField = z.string().trim().min(1).max(60);

export const UserProfile = z.object({
  /**
   * Optional, and it has to stay that way. The name step was added after there
   * were accounts, so a profile written before it exists without one — and the
   * profile save is a merge, so requiring a name here would reject every weight
   * change made by a user who predates the question.
   *
   * **Absent and null are different, and the difference is load-bearing.** The
   * save merges what it is given over what is stored, and a key that is missing
   * from the body is a key the client said nothing about — so `undefined` keeps
   * whatever is there. Clearing a surname therefore has to be sayable, and
   * `null` is how it is said. Without that, somebody deleting their surname on
   * the profile screen watches it come back on the next load.
   */
  firstName: NameField.nullish(),
  lastName: NameField.nullish(),
  sex: Sex,
  birthDate: LocalDate,
  heightCm: z.number().min(80).max(260),
  weightKg: z.number().min(25).max(400),
  activityLevel: ActivityLevel,
  objective: Objective,
  /** kg per week; sign is implied by `objective`. 0 when maintaining. */
  rateKgPerWeek: z.number().min(0).max(1.5).default(0),
  units: z.enum(['metric', 'imperial']).default('metric'),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const UpdateUserProfile = UserProfile.partial();
export type UpdateUserProfile = z.infer<typeof UpdateUserProfile>;

/**
 * A goal row is append-only with `effectiveFrom`. A day view resolves the goal
 * in effect on that date — otherwise last month's "you hit your target"
 * retroactively becomes a miss when the user's weight changes.
 */
export const Goal = z.object({
  id: z.string().uuid(),
  kcal: z.number().int().positive(),
  proteinG: z.number().int().positive(),
  carbsG: z.number().int().nonnegative(),
  fatG: z.number().int().nonnegative(),
  fiberG: z.number().int().positive(),
  effectiveFrom: LocalDate,
  /** Shown on the targets screen so the user can see the math and trust it. */
  basis: z.object({
    bmr: z.number().int(),
    tdee: z.number().int(),
    activityFactor: z.number(),
    adjustmentPct: z.number(),
    flooredAtBmr: z.boolean(),
    rateCapped: z.boolean(),
    effectiveRateKgPerWeek: z.number(),
    /**
     * The share of calories given to fat, before carbohydrate takes the rest.
     *
     * Recorded rather than assumed because it is a POLICY, not a derivation:
     * Mifflin–St Jeor produces calories, protein comes from bodyweight, and
     * fibre from a fixed rule — but nothing in the literature hands you a
     * carb/fat split. Storing the number that was used means a goal from six
     * months ago can still explain itself after the default changes.
     */
    fatPctOfKcal: z.number(),
  }),
});
export type Goal = z.infer<typeof Goal>;

/**
 * Every field optional: the targets screen lets the user override any of them.
 *
 * Note that kcal, protein, carbs and fat are not independent — four numbers
 * constrained by one equation. The server does not silently rebalance them:
 * an override is taken literally, because a target the user set and the app
 * quietly changed is worse than one that does not add up.
 */
export const SetGoal = z.object({
  kcal: z.number().int().min(800).max(8000).optional(),
  proteinG: z.number().int().min(20).max(500).optional(),
  carbsG: z.number().int().min(0).max(1200).optional(),
  fatG: z.number().int().min(0).max(400).optional(),
  fiberG: z.number().int().min(5).max(120).optional(),
  effectiveFrom: LocalDate.optional(),
});
export type SetGoal = z.infer<typeof SetGoal>;

/**
 * Targets derived from a profile without persisting anything, so the targets
 * screen can recompute live while the user is still moving a slider.
 *
 * Deliberately not a `Goal`: there is no `id` and no `effectiveFrom` because
 * nothing was written. Inventing either would let a caller mistake a preview
 * for the goal actually in effect, which is the one number the whole product
 * is measured against.
 *
 * It exists so the formula lives in exactly one place. A client that derives
 * its own targets drifts from the server the first time either side changes,
 * and the drift is invisible: both numbers look plausible.
 */
export const GoalPreview = Goal.omit({ id: true, effectiveFrom: true });
export type GoalPreview = z.infer<typeof GoalPreview>;

/**
 * Targets a model proposed, next to the ones the formula derived.
 *
 * Both are returned, always, and that is the shape doing the safety work. The
 * derived figures are what the app falls back to — if the model is unreachable,
 * unconfigured, or says something that has to be corrected, there is still a
 * complete answer on the screen that came from arithmetic anyone can check.
 *
 * `corrections` is not decoration either. A suggestion that had to be pulled
 * into range is a fact about the suggestion, and a screen that shows the number
 * without saying it was moved is showing the model's answer as if it were the
 * model's answer.
 */
export const SuggestedTargets = z.object({
  kcal: z.number().int(),
  proteinG: z.number().int(),
  /**
   * Derived from the calories above, not asked of the model.
   *
   * Fat is a fixed share of the calorie target and carbohydrate is the
   * remainder, so both follow from a figure that has already been decided.
   * Asking a model for them would be asking it to do arithmetic it was told not
   * to do, and to get an answer that has to agree with two other answers.
   */
  carbsG: z.number().int(),
  fatG: z.number().int(),
  fiberG: z.number().int(),
  /** The model's own words, addressed to the user. */
  reasoning: z.string(),
  /** One line per figure the server had to move, in plain language. Usually empty. */
  corrections: z.array(z.string()),
});
export type SuggestedTargets = z.infer<typeof SuggestedTargets>;
