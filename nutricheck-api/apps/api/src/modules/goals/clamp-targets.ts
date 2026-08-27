import type { UserProfile } from '@nutricheck/contracts';
import type { ComputedGoal } from './goal-calculator';

/** What a suggestion looked like before it was corrected, and why. */
export type ClampedTargets = {
  kcal: number;
  proteinG: number;
  fiberG: number;
  /** One entry per figure that had to be moved. Empty when nothing was. */
  corrections: string[];
};

/** Absolute edges. Outside these is not a judgement call, it is a bad number. */
const KCAL_MAX = 6000;
const KCAL_MIN = 1000;
const PROTEIN_PER_KG_MIN = 0.8;
const PROTEIN_PER_KG_MAX = 2.4;
const FIBER_MIN = 10;
const FIBER_MAX = 70;

/**
 * Holds a suggested target inside the range the derived one already obeys.
 *
 * This is the load-bearing half of letting a model propose targets. The prompt
 * asks it to stay in range and mostly it will; this is what happens when it
 * does not, and it is not optional — a calorie figure is something somebody
 * eats to for months, and the failure mode of a model is a wrong number stated
 * as confidently as a right one.
 *
 * The floor at resting burn is the same rule `computeGoal` applies to its own
 * output, and it is the one that matters most: below it the body is being asked
 * to run on less than it spends at rest. A model that suggests going under it
 * is corrected, not obeyed.
 *
 * Protein is bounded per kilo rather than absolutely, because 150 g is sensible
 * at 85 kg and not at 45. Fibre has fixed bounds because it does not scale with
 * bodyweight in any way worth modelling here.
 *
 * Every correction is recorded rather than applied silently. A suggestion that
 * had to be pulled into range is a fact about the model's answer, and the
 * screen showing that answer should be able to say so.
 */
export function clampTargets(
  suggested: { kcal: number; proteinG: number; fiberG: number },
  profile: UserProfile,
  derived: ComputedGoal,
): ClampedTargets {
  const corrections: string[] = [];

  const floor = Math.max(derived.basis.bmr, KCAL_MIN);
  let kcal = Math.round(suggested.kcal);
  if (kcal < floor) {
    corrections.push(
      `Calories raised to ${floor.toLocaleString('en-US')}, your resting burn. We do not set a target below what your body spends at rest.`,
    );
    kcal = floor;
  } else if (kcal > KCAL_MAX) {
    corrections.push(`Calories capped at ${KCAL_MAX.toLocaleString('en-US')}.`);
    kcal = KCAL_MAX;
  }

  const proteinMin = Math.round(profile.weightKg * PROTEIN_PER_KG_MIN);
  const proteinMax = Math.round(profile.weightKg * PROTEIN_PER_KG_MAX);
  let proteinG = Math.round(suggested.proteinG);
  if (proteinG < proteinMin) {
    corrections.push(`Protein raised to ${proteinMin} g, the lowest that is safe at your weight.`);
    proteinG = proteinMin;
  } else if (proteinG > proteinMax) {
    corrections.push(`Protein capped at ${proteinMax} g — past this there is no further benefit.`);
    proteinG = proteinMax;
  }

  let fiberG = Math.round(suggested.fiberG);
  if (fiberG < FIBER_MIN) {
    corrections.push(`Fibre raised to ${FIBER_MIN} g.`);
    fiberG = FIBER_MIN;
  } else if (fiberG > FIBER_MAX) {
    corrections.push(`Fibre capped at ${FIBER_MAX} g.`);
    fiberG = FIBER_MAX;
  }

  return { kcal, proteinG, fiberG, corrections };
}
