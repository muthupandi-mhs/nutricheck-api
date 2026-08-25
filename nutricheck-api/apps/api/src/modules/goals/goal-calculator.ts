import type {
  ActivityLevel,
  Objective,
  Sex,
  UserProfile,
} from '@nutricheck/contracts';

/**
 * Goal math. A pure function, deliberately: this is the number the whole product
 * is measured against, and it must be reproducible from the profile alone.
 *
 * Bases, per PLAN.md §9:
 *   BMR      Mifflin-St Jeor
 *   TDEE     BMR x activity factor
 *   Calories TDEE +/- the rate, capped at 20%, FLOORED AT BMR
 *   Protein  1.6-2.2 g/kg for active users, 0.8 g/kg absolute floor
 *   Fiber    14 g per 1000 kcal (US Dietary Guidelines basis)
 */

/** Harris-Benedict style multipliers, 1.2 sedentary to 1.9 very active. */
const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/**
 * Grams of protein per kg of bodyweight, before the cut adjustment.
 * The floor of the evidence range at rest, the top of it when training hard.
 */
const PROTEIN_G_PER_KG: Record<ActivityLevel, number> = {
  sedentary: 1.6,
  light: 1.8,
  moderate: 1.8,
  active: 2.0,
  very_active: 2.2,
};

const PROTEIN_G_PER_KG_MAX = 2.2;
/** Absolute floor. Below this is a deficiency risk, not a preference. */
const PROTEIN_G_PER_KG_FLOOR = 0.8;

/** Energy in a kg of body mass. The conventional 7700 kcal figure. */
const KCAL_PER_KG = 7700;

/**
 * A cut or bulk is capped at 20% of TDEE regardless of the rate the user asked
 * for. An aggressive rate at a low bodyweight otherwise produces a target that
 * is both unsafe and unachievable, and people abandon a tracker that tells them
 * to eat 900 kcal long before they abandon the goal.
 */
const MAX_ADJUSTMENT = 0.2;

const FIBER_G_PER_1000_KCAL = 14;

export interface GoalBasis {
  bmr: number;
  tdee: number;
  activityFactor: number;
  /** Signed. Negative for a cut. Reflects the CAPPED adjustment, not the request. */
  adjustmentPct: number;
  /** True when the calorie floor bit — surfaced so the UI can explain it. */
  flooredAtBmr: boolean;
  /**
   * True when the requested rate was reduced by the 20% cap. At a typical TDEE
   * even 0.5 kg/week exceeds it, so this is the common case rather than an edge
   * one, and the targets screen has to say so or the number looks arbitrary.
   */
  rateCapped: boolean;
  /** The rate actually implied by the applied deficit, in kg/week. */
  effectiveRateKgPerWeek: number;
}

export interface ComputedGoal {
  kcal: number;
  proteinG: number;
  fiberG: number;
  basis: GoalBasis;
}

/** Mifflin-St Jeor. */
export function basalMetabolicRate(
  sex: Sex,
  weightKg: number,
  heightCm: number,
  ageYears: number,
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === 'male' ? base + 5 : base - 161;
}

/**
 * Whole years, counting the birthday itself. Naive year subtraction is off by
 * one for anyone who has not had their birthday yet this year, which shifts BMR
 * by 5 kcal — small, but wrong for free.
 */
export function ageInYears(birthDate: string, on: Date = new Date()): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = on.getUTCFullYear() - (y ?? 0);
  const monthDelta = on.getUTCMonth() + 1 - (m ?? 1);
  if (monthDelta < 0 || (monthDelta === 0 && on.getUTCDate() < (d ?? 1))) {
    age -= 1;
  }
  return Math.max(age, 0);
}

export function computeGoal(profile: UserProfile, on: Date = new Date()): ComputedGoal {
  const age = ageInYears(profile.birthDate, on);
  const bmr = basalMetabolicRate(profile.sex, profile.weightKg, profile.heightCm, age);
  const activityFactor = ACTIVITY_FACTOR[profile.activityLevel];
  const tdee = bmr * activityFactor;

  // The rate is expressed in kg/week; convert to a daily energy delta, then cap.
  const requestedDelta = (profile.rateKgPerWeek * KCAL_PER_KG) / 7;
  const maxDelta = tdee * MAX_ADJUSTMENT;
  const cappedDelta = Math.min(requestedDelta, maxDelta);
  const rateCapped = profile.objective !== 'maintain' && requestedDelta > maxDelta;
  const signedDelta = directionOf(profile.objective) * cappedDelta;

  const uncapped = tdee + signedDelta;
  const flooredAtBmr = uncapped < bmr;
  const kcal = Math.round(flooredAtBmr ? bmr : uncapped);

  return {
    kcal,
    proteinG: Math.round(proteinTarget(profile)),
    fiberG: Math.round((kcal / 1000) * FIBER_G_PER_1000_KCAL),
    basis: {
      bmr: Math.round(bmr),
      tdee: Math.round(tdee),
      activityFactor,
      // Report what was actually applied, not what was asked for.
      adjustmentPct: tdee === 0 ? 0 : round2((signedDelta / tdee) * 100),
      flooredAtBmr,
      rateCapped,
      effectiveRateKgPerWeek:
        profile.objective === 'maintain' ? 0 : round2((cappedDelta * 7) / KCAL_PER_KG),
    },
  };
}

function directionOf(objective: Objective): number {
  if (objective === 'lose') return -1;
  if (objective === 'gain') return 1;
  return 0;
}

function proteinTarget(profile: UserProfile): number {
  let perKg = PROTEIN_G_PER_KG[profile.activityLevel];

  // Protein requirements rise in a deficit: it is what preserves lean mass
  // while the calorie target is doing the work.
  if (profile.objective === 'lose') {
    perKg = Math.min(perKg + 0.2, PROTEIN_G_PER_KG_MAX);
  }

  return Math.max(perKg, PROTEIN_G_PER_KG_FLOOR) * profile.weightKg;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
