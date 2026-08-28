import type { MealSlot, RemainingTargets, UserProfile } from '@nutricheck/contracts';
import { ageInYears } from '../goals/goal-calculator';

/**
 * What the model is told before it suggests anything.
 *
 * Everything here is already computed. The model is never asked to work out
 * what is left of a target or how much of one has been used — it is handed
 * both, so the only arithmetic available to it is arithmetic it was told not to
 * do, and there is nothing on this page it would need to.
 *
 * Written out as labelled lines rather than passed as JSON, for the reason the
 * insight and targets inputs are: a model reads a sentence more reliably than a
 * key, and this input is read four or five times over in one call.
 *
 * **The order of the sections is deliberate and was changed once.** THE PERSON
 * comes first and TODAY comes last, because the first version had it the other
 * way round and produced a gap-filling calculator: handed "60 g of protein
 * left" at the top, the model answered that and nothing else, and on a day with
 * nothing logged it had no subject at all. The person is the subject; the day
 * is a constraint on the answer. Sections are read in order and weighted
 * roughly that way, so the order is the instruction.
 */
export interface IdeasInput {
  profile: UserProfile;
  goal: { kcal: number; proteinG: number; carbsG: number; fatG: number; fiberG: number };
  eaten: { kcal: number; proteinG: number; carbsG: number; fatG: number; fiberG: number };
  remaining: RemainingTargets;
  /** Entries logged today. Zero reads very differently from four. */
  entryCount: number;
  /** The slot the clock is in, so "next" means something concrete. */
  nextMeal: MealSlot;
}

const MEAL_WORD: Record<MealSlot, string> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  snack: 'a snack',
};

/**
 * How each activity level should read to a model choosing food.
 *
 * The enum value alone underdescribes it: 'sedentary' and 'athlete' are two
 * words that sound like a scale, and what actually changes between them is how
 * much food a person has to get through in a day and how easy that is. Spelling
 * that out is the difference between a list that suits somebody and a list that
 * merely avoids contradicting their profile.
 */
const ACTIVITY_WORD: Record<UserProfile['activityLevel'], string> = {
  sedentary: 'desk-bound, little deliberate exercise',
  light: 'lightly active — some walking, occasional exercise',
  moderate: 'moderately active — exercise a few times a week',
  active: 'active — regular exercise most days',
  very_active: 'very active — hard exercise most days, or physical work',
  athlete: 'training like an athlete — high daily volume',
};

/**
 * What the person is working toward, as a sentence rather than an enum.
 *
 * Paired with the rate, because "lose weight" and "lose a kilo a week" call for
 * different food: the second is an aggressive deficit where every calorie has
 * to earn its place, and the first is not.
 */
function objectiveSentence(profile: UserProfile): string {
  if (profile.objective === 'maintain') return 'hold their weight where it is';
  const direction = profile.objective === 'lose' ? 'lose' : 'gain';
  return `${direction} ${profile.rateKgPerWeek} kg a week`;
}

export function ideasToUserTurn(input: IdeasInput): string {
  const { profile, goal, eaten, remaining, entryCount, nextMeal } = input;
  const age = ageInYears(profile.birthDate);
  const proteinPerKg = (goal.proteinG / profile.weightKg).toFixed(1);

  return [
    'THE PERSON — this is who the list is for',
    `- ${age} years old, ${profile.sex}`,
    `- ${profile.heightCm} cm, ${profile.weightKg} kg`,
    `- Lifestyle: ${ACTIVITY_WORD[profile.activityLevel]}`,
    `- Working to: ${objectiveSentence(profile)}`,
    '',
    'WHAT THEY ARE EATING TO, EVERY DAY',
    `- Calories: ${goal.kcal.toLocaleString('en-US')} kcal`,
    `- Protein: ${goal.proteinG} g (${proteinPerKg} g per kg of bodyweight)`,
    `- Carbohydrate: ${goal.carbsG} g`,
    `- Fat: ${goal.fatG} g`,
    `- Fibre: ${goal.fiberG} g`,
    '',
    'TODAY, WHICH SHAPES THE SIZE OF YOUR SUGGESTIONS RATHER THAN THEIR SUBJECT',
    entryCount === 0
      ? '- Nothing logged yet today, so the whole day is still ahead of them.'
      : `- ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} logged so far.`,
    ...consumedLines(eaten, entryCount),
    ...remainingLines(remaining),
    '',
    `They are most likely eating ${MEAL_WORD[nextMeal]} next.`,
  ].join('\n');
}

/**
 * Omitted entirely on an empty day.
 *
 * Five lines of zeroes is not information, and a model reading "Protein: 0 g of
 * 145 g" at the top of its evidence treats the day as a deficit to be attacked
 * rather than as one that has not started.
 */
function consumedLines(
  eaten: IdeasInput['eaten'],
  entryCount: number,
): string[] {
  if (entryCount === 0) return [];
  return [
    `- Eaten so far: ${Math.round(eaten.kcal).toLocaleString('en-US')} kcal, ` +
      `${Math.round(eaten.proteinG)} g protein, ${Math.round(eaten.fiberG)} g fibre`,
  ];
}

/**
 * The gap, in words, with "over" said out loud.
 *
 * A negative number in a list of targets is easy to read past, and reading past
 * it is what produces a suggestion that pushes somebody further over. Saying
 * "180 kcal OVER" costs four characters and removes the ambiguity entirely.
 *
 * A null target is omitted rather than printed as zero. "0 g left" and "no
 * target set" are opposite instructions, and the model cannot tell them apart
 * from a figure alone.
 */
function remainingLines(remaining: RemainingTargets): string[] {
  const rows: Array<[string, number | null, string]> = [
    ['Calories', remaining.kcal, 'kcal'],
    ['Protein', remaining.proteinG, 'g'],
    ['Carbohydrate', remaining.carbsG, 'g'],
    ['Fat', remaining.fatG, 'g'],
    ['Fibre', remaining.fiberG, 'g'],
  ];

  const lines = rows.flatMap(([label, value, unit]) => {
    if (value === null) return [];
    const magnitude = Math.abs(Math.round(value)).toLocaleString('en-US');
    return value < 0
      ? [`- ${label}: ${magnitude} ${unit} OVER the target`]
      : [`- ${label}: ${magnitude} ${unit} left`];
  });

  if (lines.length === 0) {
    return ['- No daily targets are set, so suggest for the person alone.'];
  }

  return ['- Left today:', ...lines.map((line) => `  ${line.slice(2)}`)];
}
