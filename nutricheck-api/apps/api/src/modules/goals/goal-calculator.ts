import { KCAL_PER_G } from '@nutricheck/contracts';
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

/**
 * Harris-Benedict style multipliers.
 *
 * The first five are the standard figures and are not ours to move: 1.2 through
 * 1.9 in the steps the literature uses. `athlete` is the one that is not
 * standard. It sits at 2.0 for someone training twice a day on top of a
 * physical job -- a case 1.9 was already stretching to cover -- and 2.0 is
 * within the range published sources use for it rather than a number picked to
 * fill a sixth tile.
 */
const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
  athlete: 2.0,
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
  // Already the top of the evidence range at very_active; more training does
  // not move it, so athlete holds rather than inventing a higher one.
  athlete: 2.2,
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

/**
 * The share of calories given to fat. Carbohydrate takes whatever is left.
 *
 * This is a POLICY, not a derivation, and it is the only number in this file
 * that is. Mifflin–St Jeor produces calories; protein comes from bodyweight;
 * fibre from a published per-1000-kcal figure. Nothing comparable exists for
 * the carb/fat split — the evidence supports a wide band, and within it the
 * split is a preference rather than a finding.
 *
 * 25% sits at the low end of the usual 20–35% range, which suits a protein
 * target already set by bodyweight: raising fat here would squeeze carbohydrate
 * without changing anything the tracker actually measures. It is recorded on
 * every goal as `basis.fatPctOfKcal` so a target from six months ago can still
 * explain itself after this constant moves.
 */
const FAT_PCT_OF_KCAL = 0.25;

/**
 * Fat and carbohydrate for a given calorie and protein target.
 *
 * Split out because the calorie figure has two sources now. It is normally the
 * formula's, and it is sometimes a model's suggestion that moved it — and a
 * moved calorie target with the original macros beside it is three numbers that
 * do not add up, on the screen where somebody is deciding whether to trust
 * them.
 *
 * Carbohydrate takes the remainder, by difference — the same definition USDA
 * uses for nutrient 1005 and the same one the curated dishes are built with.
 * Clamped at zero: a very high protein target on a small calorie budget can
 * consume the whole allowance, and a negative carbohydrate target is worse than
 * an honest zero.
 */
export function macrosFor(kcal: number, proteinG: number): { carbsG: number; fatG: number } {
  const fatG = Math.round((kcal * FAT_PCT_OF_KCAL) / KCAL_PER_G.fat);
  const carbsG = Math.max(
    0,
    Math.round((kcal - proteinG * KCAL_PER_G.protein - fatG * KCAL_PER_G.fat) / KCAL_PER_G.carbs),
  );
  return { carbsG, fatG };
}

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
  /** The fat share used for this goal. See FAT_PCT_OF_KCAL — it is policy, so it is stored. */
  fatPctOfKcal: number;
  /** The rate actually implied by the applied deficit, in kg/week. */
  effectiveRateKgPerWeek: number;
}

export interface ComputedGoal {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
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

  /**
   * The deficit actually applied, after BOTH rails.
   *
   * `cappedDelta` is only the first of them. When the floor bites, the real
   * deficit is whatever fits between TDEE and BMR — less than the cap allowed —
   * so reporting the capped figure as the effective rate overstates what the
   * target will actually do. That number is about to be shown to somebody as a
   * projection, and a projection that is faster than the arithmetic behind it
   * is the one kind of wrong worth avoiding here.
   */
  const appliedDelta = flooredAtBmr ? Math.abs(tdee - bmr) : cappedDelta;

  const proteinG = Math.round(proteinTarget(profile));
  const { carbsG, fatG } = macrosFor(kcal, proteinG);

  return {
    kcal,
    proteinG,
    carbsG,
    fatG,
    fiberG: Math.round((kcal / 1000) * FIBER_G_PER_1000_KCAL),
    basis: {
      bmr: Math.round(bmr),
      tdee: Math.round(tdee),
      activityFactor,
      // Report what was actually applied, not what was asked for.
      adjustmentPct: tdee === 0 ? 0 : round2((signedDelta / tdee) * 100),
      flooredAtBmr,
      rateCapped,
      fatPctOfKcal: FAT_PCT_OF_KCAL,
      effectiveRateKgPerWeek:
        profile.objective === 'maintain' ? 0 : round2((appliedDelta * 7) / KCAL_PER_KG),
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
