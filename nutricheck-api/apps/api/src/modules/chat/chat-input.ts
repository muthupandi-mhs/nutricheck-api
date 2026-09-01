import type { ChatTurn, DaySummary } from '@nutricheck/contracts';

/**
 * Render the day and the conversation as the model's user turn.
 *
 * The same discipline `insight-input.ts` keeps, for the same reason: the model
 * only ever sees numbers this app computed. It has no database, no tool call
 * and no memory — everything it is allowed to assert about somebody's day is in
 * this string, which makes "never invent a number" an instruction it can
 * actually follow rather than a hope.
 *
 * Unknowns are spelled out rather than omitted, because a missing line invites
 * the model to assume zero and answer "you have had no fibre today" about a day
 * whose fibre was simply never measured.
 */
export function chatContext({
  day,
  history,
  message,
  date,
}: {
  day: DaySummary;
  history: ChatTurn[];
  message: string;
  date: string;
}): string {
  const eaten = day.totals;
  const goal = day.goal;

  const lines: string[] = [
    `Today is ${date}.`,
    '',
    'What they have eaten today, and their target:',
    line('Calories', eaten.kcal, goal.kcal, 'kcal'),
    line('Protein', eaten.proteinG, goal.proteinG, 'g'),
    line('Carbs', eaten.carbsG, goal.carbsG, 'g'),
    line('Fat', eaten.fatG, goal.fatG, 'g'),
    line('Fibre', eaten.fiberG, goal.fiberG, 'g'),
  ];

  const unmeasured = [
    eaten.carbsUnmeasuredItems > 0 ? `carbs on ${eaten.carbsUnmeasuredItems}` : null,
    eaten.fatUnmeasuredItems > 0 ? `fat on ${eaten.fatUnmeasuredItems}` : null,
    eaten.fiberUnmeasuredItems > 0 ? `fibre on ${eaten.fiberUnmeasuredItems}` : null,
  ].filter(Boolean);

  if (unmeasured.length > 0) {
    lines.push(
      '',
      `Some items were never measured for ${unmeasured.join(', ')} item(s). Those totals are floors, not readings — say so if you quote them.`,
    );
  }

  lines.push('', 'Logged today:');
  if (day.entries.length === 0) {
    lines.push('- nothing yet');
  } else {
    for (const entry of day.entries) {
      for (const item of entry.items) {
        lines.push(
          `- ${entry.meal}: ${item.food.name}, ${round(item.grams)} g, ${round(item.nutrients.kcal)} kcal`,
        );
      }
    }
  }

  if (history.length > 0) {
    lines.push('', 'Earlier in this conversation:');
    for (const turn of history) {
      lines.push(`${turn.role === 'user' ? 'Them' : 'You'}: ${turn.text}`);
    }
  }

  lines.push('', 'Their message:', message);

  return lines.join('\n');
}

/**
 * One nutrient, eaten against target.
 *
 * A target of zero is written as "no target set" rather than as "of 0", which
 * is the state a brand-new account is in and reads, unhandled, as an accusation
 * that they have overshot a goal of nothing.
 */
function line(label: string, amount: number, target: number, unit: string): string {
  if (target <= 0) return `- ${label}: ${round(amount)} ${unit} eaten, no target set`;
  const left = Math.round(target - amount);
  const tail = left >= 0 ? `${left} ${unit} left` : `${Math.abs(left)} ${unit} over`;
  return `- ${label}: ${round(amount)} of ${round(target)} ${unit}, ${tail}`;
}

/** One decimal. These are estimates for most rows; more precision would be theatre. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}
