import type { MealSlot, RemainingTargets, UserProfile } from '@nutricheck/contracts';
import { ageInYears } from '../goals/goal-calculator';

/**
 * What the model is told before it suggests anything.
 *
 * Everything here is already computed. The model is never asked to work out
 * what is left of a target, how far into a fast somebody is, or which way the
 * scale is going — it is handed all three, so the only arithmetic available to
 * it is arithmetic it was told not to do, and there is nothing on this page it
 * would need to.
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
 *
 * The two sections added since sit either side of that line on purpose:
 *
 * - **Weight goes with the person**, directly under them. It is the only
 *   evidence in here about whether what they are already doing is working, and
 *   it belongs to their life rather than to their afternoon.
 * - **Fasting goes with the day**, just above it. An open fast is a constraint
 *   on WHEN, exactly as the remaining calories are a constraint on HOW MUCH,
 *   and the closing line is written from it — because "they are most likely
 *   eating dinner next" is a false sentence to hand a model about somebody
 *   with five hours left on a sixteen-hour fast.
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
  /** Null when this user has never fasted. See `FastingContext`. */
  fasting: FastingContext | null;
  /** Null when nobody has ever weighed in. See `WeightContext`. */
  weight: WeightContext | null;
}

/**
 * Fasting, as the suggestion path needs it rather than as the screen draws it.
 *
 * `FastingSummary` carries a list of recent fasts and an open one holding a
 * `startedAt`. Neither is any use to a model: a list of thirty rows is history
 * to scroll, and an instant is a subtraction waiting to be got wrong. So the
 * elapsed hours are computed on the server against the same clock the rest of
 * the request uses, and what arrives here is already a duration.
 *
 * `hoursToGo` is clamped at zero rather than going negative. A fast past its
 * target is a state — they may eat whenever they decide to — and a negative
 * number of hours remaining is a figure a model will read as a countdown.
 */
export interface FastingContext {
  /** The fast running right now, or null when they are not fasting. */
  current: { hoursElapsed: number; targetHours: number; hoursToGo: number } | null;
  /** Finished fasts, all-time. Null until one has actually finished. */
  habit: { completed: number; reached: number; averageHours: number } | null;
  /** The protocol they are on — the running fast's target, else the last one's. */
  lastTargetHours: number;
}

/**
 * Which way the scale is going, and which way they meant it to.
 *
 * Both figures, because either alone is half a fact. "Losing 0.15 kg a week"
 * is neither good nor bad news until you know they were aiming at 0.5, and a
 * "progress" number already normalized against the objective is one nobody can
 * read at a glance.
 *
 * `trend` is null both when there are too few readings to fit a line and when
 * the ones there are cover too short a span — see `TREND_MIN_SPAN_DAYS`.
 */
export interface WeightContext {
  currentKg: number;
  /** The first reading ever recorded. Null when today's is also the first. */
  startKg: number | null;
  trend: {
    /** Signed. Negative is losing. The least-squares slope, not two endpoints. */
    kgPerWeek: number;
    /** Signed the same way. Null when they are maintaining. */
    intendedKgPerWeek: number | null;
    spanDays: number;
  } | null;
}

/**
 * Below this, the slope is not reported at all — only the weight itself.
 *
 * `WeightTrend` exists as soon as there are two readings on different days,
 * which is the right bar for a chart and much too low a bar for advice. A
 * litre of water is a kilo: two weigh-ins four days apart can put "gaining
 * 1.8 kg a week" in front of a model that will then reshape the whole list
 * around a bathroom visit. Two weeks is roughly where a real trend clears the
 * noise at the rates people actually change weight.
 */
export const TREND_MIN_SPAN_DAYS = 14;

/**
 * Below this in magnitude, the scale is described as not moving.
 *
 * A fitted slope is never exactly zero, and 0.02 kg a week printed as a
 * direction is a direction that does not exist.
 */
const STEADY_KG_PER_WEEK = 0.05;

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
  const { profile, goal, eaten, remaining, entryCount, nextMeal, fasting, weight } = input;
  const age = ageInYears(profile.birthDate);
  const proteinPerKg = (goal.proteinG / profile.weightKg).toFixed(1);

  return [
    'THE PERSON — this is who the list is for',
    `- ${age} years old, ${profile.sex}`,
    `- ${profile.heightCm} cm, ${profile.weightKg} kg`,
    `- Lifestyle: ${ACTIVITY_WORD[profile.activityLevel]}`,
    `- Working to: ${objectiveSentence(profile)}`,
    ...weightSection(weight),
    '',
    'WHAT THEY ARE EATING TO, EVERY DAY',
    `- Calories: ${goal.kcal.toLocaleString('en-US')} kcal`,
    `- Protein: ${goal.proteinG} g (${proteinPerKg} g per kg of bodyweight)`,
    `- Carbohydrate: ${goal.carbsG} g`,
    `- Fat: ${goal.fatG} g`,
    `- Fibre: ${goal.fiberG} g`,
    ...fastingSection(fasting),
    '',
    'TODAY, WHICH SHAPES THE SIZE OF YOUR SUGGESTIONS RATHER THAN THEIR SUBJECT',
    entryCount === 0
      ? '- Nothing logged yet today, so the whole day is still ahead of them.'
      : `- ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} logged so far.`,
    ...consumedLines(eaten, entryCount),
    ...remainingLines(remaining),
    '',
    closingLine(nextMeal, fasting),
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

/**
 * What the scale says, next to what they said it would say.
 *
 * Omitted entirely for somebody who has never weighed in, and reduced to the
 * bare weight when there is not enough span to fit a line to — see
 * `TREND_MIN_SPAN_DAYS`. The alternative to omitting is printing a slope with
 * a caveat next to it, and a caveat is exactly the part of an input a model
 * drops when it is looking for a reason to pick a food.
 *
 * The comparison is made HERE and handed over as a sentence, for the reason
 * the remaining gap is: the model reading "-0.15" against "-0.5" and working
 * out which is bigger is a place it can be wrong, and there is no reason to
 * leave it one.
 */
function weightSection(weight: WeightContext | null): string[] {
  if (!weight) return [];

  const head = ['', 'WHAT THE SCALE ACTUALLY SAYS — measured, not intended'];
  const now = `- They weigh ${weight.currentKg} kg.`;
  const start =
    weight.startKg === null
      ? []
      : [`- The first weight they ever recorded was ${weight.startKg} kg.`];

  if (!weight.trend || weight.trend.spanDays < TREND_MIN_SPAN_DAYS) {
    return [
      ...head,
      now,
      ...start,
      '- There is not enough weigh-in history yet to say which way it is going, so do not guess at one.',
    ];
  }

  const { kgPerWeek, intendedKgPerWeek, spanDays } = weight.trend;

  return [
    ...head,
    now,
    ...start,
    `- Over the last ${spanDays} days: ${movementPhrase(kgPerWeek)}.`,
    `- ${paceSentence(kgPerWeek, intendedKgPerWeek)}`,
  ];
}

/** "losing 0.40 kg a week", "holding steady". Signed input, negative is losing. */
function movementPhrase(kgPerWeek: number): string {
  if (Math.abs(kgPerWeek) < STEADY_KG_PER_WEEK) return 'holding steady';
  const magnitude = Math.abs(kgPerWeek).toFixed(2);
  return `${kgPerWeek < 0 ? 'losing' : 'gaining'} ${magnitude} kg a week`;
}

/**
 * Intent against outcome, in one sentence, with the comparison already made.
 *
 * Deliberately flat. This is the section most likely to be turned into a
 * telling-off by a model given room to editorialise, and the prompt forbids
 * that — but the input should not supply the raw material for it either. "It
 * is moving slower than they planned" is a fact about a rate. "They are
 * behind" is a verdict about a person.
 */
function paceSentence(kgPerWeek: number, intended: number | null): string {
  const moving = Math.abs(kgPerWeek) >= STEADY_KG_PER_WEEK;

  if (intended === null) {
    return moving
      ? `They are not trying to change weight, and it is ${movementPhrase(kgPerWeek)} anyway.`
      : 'They are not trying to change weight, and it is not changing — what they eat is holding them there.';
  }

  const aim = `${intended < 0 ? 'lose' : 'gain'} ${Math.abs(intended)} kg a week`;

  if (!moving) {
    return `They meant to ${aim}, and the scale has not moved.`;
  }

  if (Math.sign(kgPerWeek) !== Math.sign(intended)) {
    return `They meant to ${aim}, and it is going the other way.`;
  }

  const ratio = Math.abs(kgPerWeek) / Math.abs(intended);
  if (ratio < 0.6) return `They meant to ${aim}, so it is moving slower than they planned.`;
  if (ratio > 1.4) return `They meant to ${aim}, so it is moving faster than they planned.`;
  return `They meant to ${aim}, so it is going roughly to plan.`;
}

/**
 * How they eat, when there is anything to say about it.
 *
 * Omitted whole for somebody who has never fasted — which is most people, and
 * for whom a line reading "not fasting" is an invitation to suggest they start.
 * The app does not propose protocols; it reports the one somebody chose.
 *
 * A running fast leads, because it is the constraint. The habit follows it,
 * because a sixteen-hour window somebody has kept forty times is a fact about
 * how they eat, worth knowing on an afternoon when no fast is running.
 */
function fastingSection(fasting: FastingContext | null): string[] {
  if (!fasting) return [];

  const lines: string[] = ['', 'HOW THEY EAT — THEY FAST, AND THAT SETS WHEN THEY EAT'];
  const open = fasting.current;

  // Every target is phrased as "a target of N hours" rather than as an
  // "N-hour target", because the second needs an article the number decides —
  // "a 16-hour fast" but "an 18-hour fast" — and 8, 11 and 18 are all real
  // targets somebody can set.
  if (open && open.hoursToGo > 0) {
    lines.push(
      `- A fast is running: ${hoursWord(open.hoursElapsed)} in, against a target of ${open.targetHours} hours.`,
      `- About ${hoursWord(open.hoursToGo)} before their eating window opens.`,
    );
  } else if (open) {
    lines.push(
      `- A fast is running: ${hoursWord(open.hoursElapsed)} in, past its target of ${open.targetHours} hours.`,
      '- They have made the target, so they may break it whenever they choose.',
    );
  } else {
    lines.push(
      `- Not fasting right now. The protocol they are on is a fast of ${fasting.lastTargetHours} hours.`,
    );
  }

  if (fasting.habit) {
    lines.push(
      `- The habit: ${fasting.habit.completed} fasts finished, ` +
        `${fasting.habit.reached} of them reached their target, ` +
        `${hoursWord(fasting.habit.averageHours)} on average.`,
    );
  }

  return lines;
}

/**
 * The last line of the input, and the one an open fast rewrites.
 *
 * `nextMeal` comes off the clock and knows nothing about fasting, so on its own
 * it would tell the model that somebody five hours from their window is "most
 * likely eating dinner next" — which invites a list to eat right now, on a
 * screen belonging to somebody who has decided not to. The meal is still named,
 * because these are suggestions for a meal; what changes is when it is.
 */
function closingLine(nextMeal: MealSlot, fasting: FastingContext | null): string {
  const open = fasting?.current;

  if (!open) return `They are most likely eating ${MEAL_WORD[nextMeal]} next.`;

  if (open.hoursToGo <= 0) {
    return 'Their fast has passed its target, so the next thing they eat breaks it — suggest for that meal, whenever they take it.';
  }

  return `They are still fasting. Suggest for the meal that opens their window in about ${hoursWord(open.hoursToGo)} — not for eating right now.`;
}

/**
 * A duration a person would say out loud.
 *
 * Rounded to five minutes under the hour and to one decimal above it, because
 * "14.28 hours into your fast" is a precision this input does not have, and
 * reads as a stopwatch rather than as a state.
 */
function hoursWord(hours: number): string {
  if (hours < 1) {
    const minutes = Math.max(5, Math.round((hours * 60) / 5) * 5);
    return `${minutes} minutes`;
  }
  const value = Number(hours.toFixed(1));
  return `${value} ${value === 1 ? 'hour' : 'hours'}`;
}
