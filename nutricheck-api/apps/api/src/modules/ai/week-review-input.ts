import type { WeekAverage, WeekFacts } from '@nutricheck/contracts';

/**
 * Render the computed week as the model's user turn.
 *
 * Shared by both providers, for the reason `factsToUserTurn` is: a review must
 * not read differently depending on which vendor answered, and there should be
 * exactly one place enforcing "the model only ever sees numbers we calculated".
 *
 * **Reading order is the instruction.** How much of the week is recorded comes
 * first, before any average, because an average over two days is a different
 * kind of claim from an average over seven and the model has to know which one
 * it is holding before it reads the figure. The ideas prompt learned the same
 * lesson from the other direction — what leads is what the answer is about.
 *
 * Absences are spelled out rather than omitted. A missing line invites a model
 * to assume zero; "no target set" and "not weighed" say what is actually true,
 * and the weight section is left out entirely when there is no trend, because
 * the prompt forbids remarking on its absence.
 */
export function weekFactsToUserTurn(facts: WeekFacts): string {
  const lines: string[] = [
    `Week: ${facts.from} to ${facts.to}`,
    `Days logged: ${facts.loggedDays} of 7`,
  ];

  if (facts.loggedDays === 0) {
    // Nothing below would mean anything, and every average is null. This
    // string should never reach a model — the service returns early on an
    // empty week — but a renderer that produced a page of "not measured" for
    // one that slipped through would be inviting the model to fill the gap.
    lines.push('', 'Nothing was logged in this week.');
    return lines.join('\n');
  }

  lines.push(
    `Days on target for calories: ${facts.onTargetDays} of the ${facts.loggedDays} logged (within 15% either side)`,
    `Current streak: ${facts.streakDays} day${facts.streakDays === 1 ? '' : 's'}`,
    '',
    `Daily averages across the ${facts.loggedDays} logged day${facts.loggedDays === 1 ? '' : 's'} — NOT across seven:`,
    averageLine('Calories', facts.kcal, 'kcal'),
    averageLine('Protein', facts.proteinG, 'g'),
    averageLine('Carbs', facts.carbsG, 'g'),
    averageLine('Fat', facts.fatG, 'g'),
    averageLine('Fibre', facts.fiberG, 'g'),
  );

  if (facts.closestDay && facts.furthestDay) {
    lines.push('', 'Individual days:');
    lines.push(`- Nearest target: ${dayLine(facts.closestDay)}`);
    // Said plainly rather than dropped. One logged day is its own nearest and
    // furthest, and a model handed the same date twice with no explanation
    // would write about two days.
    if (facts.furthestDay.date === facts.closestDay.date) {
      lines.push('- Furthest from target: the same day — only one day was logged');
    } else {
      lines.push(`- Furthest from target: ${dayLine(facts.furthestDay)}`);
    }
  }

  lines.push('', 'The seven days before this week:');
  if (facts.previous.loggedDays === 0) {
    lines.push('- Nothing was logged, so there is no comparison to make');
  } else {
    lines.push(
      `- ${facts.previous.loggedDays} day${facts.previous.loggedDays === 1 ? '' : 's'} logged, averaging ${
        facts.previous.kcalAverage === null ? 'no calories recorded' : `${round(facts.previous.kcalAverage)} kcal`
      }`,
    );
  }

  // Omitted entirely when there is no trend. The prompt forbids mentioning
  // weight in that case, and the surest way to hold a model to that is to give
  // it nothing on the subject to react to.
  if (facts.weight) {
    const { kgPerWeek, deltaKg, spanDays, intendedKgPerWeek } = facts.weight;
    lines.push(
      '',
      'The scale, as a rate as of the end of this week. It is fitted over a longer span than seven days, so it is how fast this person is moving — NOT how much they moved during this week:',
      `- Trend: ${signed(kgPerWeek, 2)} kg per week`,
      `- Change between the first and last reading: ${signed(deltaKg, 1)} kg over ${spanDays} day${spanDays === 1 ? '' : 's'}`,
      intendedKgPerWeek === null
        ? '- Intended rate: none — this person is maintaining, so there is no rate to miss'
        : `- Intended rate: ${signed(intendedKgPerWeek, 2)} kg per week`,
    );
  }

  return lines.join('\n');
}

function averageLine(label: string, average: WeekAverage, unit: string): string {
  if (average.average === null) {
    return `- ${label}: not measured on any logged day`;
  }

  const parts = [`${round(average.average)} ${unit}`];

  if (average.target !== null && average.percentOfTarget !== null) {
    parts.push(`against a ${round(average.target)} ${unit} target (${average.percentOfTarget}%)`);
  } else {
    parts.push('(no target set)');
  }

  if (average.deltaFromTarget !== null) {
    const delta = average.deltaFromTarget;
    // Named in both directions rather than left as a sign. "−27" reaches the
    // model as a token it has to interpret; "27 g under target" cannot be read
    // backwards, and reading it backwards is the one error here that would be
    // invisible to the reader.
    parts.push(
      delta < 0
        ? `— ${round(Math.abs(delta))} ${unit} under target`
        : `— ${round(delta)} ${unit} over target`,
    );
  }

  return `- ${label}: ${parts.join(' ')}`;
}

function dayLine(mark: { date: string; kcal: number; offByKcal: number }): string {
  const off = Math.round(mark.offByKcal);
  const direction = off < 0 ? 'under' : 'over';
  return `${mark.date}, ${round(mark.kcal)} kcal — ${Math.abs(off)} kcal ${direction} target`;
}

/** Whole numbers for kcal, one decimal for grams — what a UI would show. */
function round(value: number): number {
  return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}

/** Keeps the plus, because a trend of +0.3 and one of 0.3 read differently. */
function signed(value: number, places: number): string {
  const fixed = value.toFixed(places);
  return value > 0 ? `+${fixed}` : fixed;
}
