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
]);
export type ActivityLevel = z.infer<typeof ActivityLevel>;

export const Objective = z.enum(['lose', 'maintain', 'gain']);
export type Objective = z.infer<typeof Objective>;

export const UserProfile = z.object({
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
  }),
});
export type Goal = z.infer<typeof Goal>;

/** Every field optional: the targets screen lets the user override any of the three. */
export const SetGoal = z.object({
  kcal: z.number().int().min(800).max(8000).optional(),
  proteinG: z.number().int().min(20).max(500).optional(),
  fiberG: z.number().int().min(5).max(120).optional(),
  effectiveFrom: LocalDate.optional(),
});
export type SetGoal = z.infer<typeof SetGoal>;
