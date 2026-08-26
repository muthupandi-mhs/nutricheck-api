import type { MacroShare, MealFacts } from '@nutricheck/contracts';

/**
 * Render the computed facts as the model's user turn.
 *
 * Shared by both providers so a note cannot read differently depending on which
 * one answered — and so there is exactly one place where the rule "the model
 * only ever sees numbers we calculated" is enforced.
 *
 * Unknowns are spelled out rather than omitted. A missing line invites the
 * model to assume zero; the word "unmeasured" is the only thing that stops a
 * note claiming a meal had no fibre when three of its items were simply never
 * measured for it.
 */
export function factsToUserTurn(facts: MealFacts): string {
  const lines: string[] = [
    `Meal: ${facts.meal}`,
    `Date: ${facts.date}`,
    `Entries in this meal: ${facts.entryCount}`,
    '',
    'This meal:',
    macroLine('Calories', facts.kcal, 'kcal'),
    macroLine('Protein', facts.proteinG, 'g'),
    macroLine('Carbs', facts.carbsG, 'g'),
    macroLine('Fat', facts.fatG, 'g'),
    macroLine('Fibre', facts.fiberG, 'g'),
    '',
    'Left for the rest of today, after everything logged so far:',
    remainingLine('Calories', facts.remaining.kcal, 'kcal'),
    remainingLine('Protein', facts.remaining.proteinG, 'g'),
    remainingLine('Carbs', facts.remaining.carbsG, 'g'),
    remainingLine('Fat', facts.remaining.fatG, 'g'),
    remainingLine('Fibre', facts.remaining.fiberG, 'g'),
  ];

  return lines.join('\n');
}

function macroLine(label: string, share: MacroShare, unit: string): string {
  if (share.amount === null) {
    return `- ${label}: unmeasured for every item in this meal`;
  }

  const parts = [`${round(share.amount)} ${unit}`];

  if (share.target !== null && share.percentOfTarget !== null) {
    parts.push(`of a ${round(share.target)} ${unit} target (${share.percentOfTarget}%)`);
  } else {
    parts.push('(no target set)');
  }

  if (share.unmeasuredItems > 0) {
    // Said plainly, because a partial measurement is not a small measurement.
    parts.push(
      `— ${share.unmeasuredItems} item${share.unmeasuredItems === 1 ? '' : 's'} in this meal unmeasured, so this total is only what was measured`,
    );
  }

  return `- ${label}: ${parts.join(' ')}`;
}

function remainingLine(label: string, value: number | null, unit: string): string {
  if (value === null) return `- ${label}: no target set`;
  if (value < 0) return `- ${label}: ${round(Math.abs(value))} ${unit} over target`;
  return `- ${label}: ${round(value)} ${unit} left`;
}

/** Whole numbers for kcal, one decimal for grams — what a UI would show. */
function round(value: number): number {
  return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}
