import type { GoalPreview, UserProfile } from '@nutricheck/contracts';
import { ageInYears } from '../goals/goal-calculator';

/**
 * Everything the model is allowed to know about this person, as one turn.
 *
 * Written out rather than passed as JSON for the same reason the insight input
 * is: the model reads it, and a labelled line is read more reliably than a key.
 *
 * Every figure here is already computed. The model is never asked to derive the
 * resting burn or the deficit — it is handed both, so the only arithmetic it
 * could do is arithmetic it was told not to do, and there is nothing here it
 * would need to.
 *
 * `bmr` is on the list because it is the floor: the prompt tells the model
 * calories can never go under it, and a limit stated without its value is a
 * limit the model has to guess at.
 */
export function profileToUserTurn(
  profile: UserProfile,
  derived: GoalPreview,
  now = new Date(),
): string {
  const age = ageInYears(profile.birthDate, now);
  const perKg = (derived.proteinG / profile.weightKg).toFixed(1);

  const objective =
    profile.objective === 'maintain'
      ? 'maintain their weight'
      : `${profile.objective} ${profile.rateKgPerWeek} kg a week`;

  return [
    'THE PERSON',
    `- ${age} years old, ${profile.sex}`,
    `- ${profile.heightCm} cm, ${profile.weightKg} kg`,
    `- Activity: ${profile.activityLevel.replace('_', ' ')}`,
    `- Goal: ${objective}`,
    '',
    'WHAT THE FORMULA PRODUCED',
    `- Resting burn: ${derived.basis.bmr.toLocaleString('en-US')} kcal (calories may never go below this)`,
    `- Daily burn including activity: ${derived.basis.tdee.toLocaleString('en-US')} kcal`,
    `- Calories: ${derived.kcal.toLocaleString('en-US')} kcal`,
    `- Protein: ${derived.proteinG} g (${perKg} g per kg of bodyweight)`,
    `- Fibre: ${derived.fiberG} g`,
    derived.basis.flooredAtBmr
      ? '- NOTE: the calorie figure was already held at their resting burn. The rate they chose would have gone below it.'
      : `- Adjustment applied: ${derived.basis.adjustmentPct}%`,
  ].join('\n');
}
