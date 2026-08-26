import type { DaySummary, MealFacts } from '@nutricheck/contracts';
import { InsightsService } from '../insights.service';
import { factsToUserTurn } from '../../ai/insight-input';

/**
 * The arithmetic behind a note.
 *
 * This is the half the model is not allowed to do, so it is the half that has
 * to be right. Every case here is a way a note could state something false
 * while looking perfectly reasonable — an unmeasured nutrient read as zero, a
 * percentage of a target nobody set, a share computed over the wrong meal.
 */

const nutrients = (
  kcal: number,
  proteinG: number,
  over: Partial<{ carbsG: number | null; fatG: number | null; fiberG: number | null }> = {},
) => ({
  kcal,
  proteinG,
  carbsG: over.carbsG === undefined ? 20 : over.carbsG,
  carbsState: (over.carbsG === null ? 'unknown' : 'known') as 'known' | 'unknown',
  fatG: over.fatG === undefined ? 5 : over.fatG,
  fatState: (over.fatG === null ? 'unknown' : 'known') as 'known' | 'unknown',
  fiberG: over.fiberG === undefined ? 4 : over.fiberG,
  fiberState: (over.fiberG === null ? 'unknown' : 'known') as 'known' | 'unknown',
});

const entry = (meal: string, items: ReturnType<typeof nutrients>[]) => ({
  id: 'e1',
  clientId: 'c1',
  loggedAt: '2026-08-26T08:00:00.000Z',
  meal,
  source: 'text',
  phrase: null,
  items: items.map((n, i) => ({
    id: `i${i}`,
    food: { id: `f${i}`, name: 'Food', brand: null, kcalPer100g: 100 },
    grams: 100,
    quantityType: 'exact_mass',
    quantitySource: 'stated',
    nutrients: n,
  })),
});

const day = (over: Partial<DaySummary> = {}): DaySummary =>
  ({
    date: '2026-08-26',
    totals: {
      kcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      fiberG: 0,
      carbsUnmeasuredItems: 0,
      fatUnmeasuredItems: 0,
      fiberUnmeasuredItems: 0,
    },
    goal: { kcal: 1700, proteinG: 145, carbsG: 145, fatG: 60, fiberG: 35 },
    entries: [],
    ...over,
  }) as DaySummary;

/** Reaches the private fact builder without standing up Nest. */
function factsFor(summary: DaySummary, meal = 'breakfast'): MealFacts {
  const service = new InsightsService(
    { day: async () => summary } as never,
    { isConfigured: false } as never,
    { get: async () => null, set: async () => 'OK' } as never,
  );
  return (service as unknown as {
    factsFor: (d: DaySummary, m: string, date: string) => MealFacts;
  }).factsFor(summary, meal, '2026-08-26');
}

describe('shares', () => {
  it('reports a meal against the day target, not the day total', async () => {
    const facts = factsFor(
      day({ entries: [entry('breakfast', [nutrients(236, 37.5)])] as never }),
    );

    expect(facts.kcal.amount).toBe(236);
    expect(facts.proteinG.amount).toBe(37.5);
    // 37.5 / 145 — the figure the pasted example called "roughly 26%".
    expect(facts.proteinG.percentOfTarget).toBe(26);
  });

  it('counts only the requested meal', async () => {
    const facts = factsFor(
      day({
        entries: [
          entry('breakfast', [nutrients(236, 37.5)]),
          entry('lunch', [nutrients(600, 40)]),
        ] as never,
      }),
    );

    expect(facts.kcal.amount).toBe(236);
    expect(facts.entryCount).toBe(1);
  });

  it('is empty for a meal with nothing in it', async () => {
    const facts = factsFor(day({ entries: [entry('lunch', [nutrients(600, 40)])] as never }));
    expect(facts.entryCount).toBe(0);
  });
});

describe('what must not be claimed', () => {
  it('reports an entirely unmeasured nutrient as null, never as zero', async () => {
    // The failure this prevents: a note reading "no fibre in that meal" when
    // nobody measured it. Unknown is not zero.
    const facts = factsFor(
      day({ entries: [entry('breakfast', [nutrients(236, 37.5, { fiberG: null })])] as never }),
    );

    expect(facts.fiberG.amount).toBeNull();
    expect(facts.fiberG.percentOfTarget).toBeNull();
    expect(facts.fiberG.unmeasuredItems).toBe(1);
  });

  it('keeps a partial total but says how much was missed', async () => {
    const facts = factsFor(
      day({
        entries: [
          entry('breakfast', [
            nutrients(200, 20, { fiberG: 4 }),
            nutrients(100, 10, { fiberG: null }),
          ]),
        ] as never,
      }),
    );

    // One item measured, one not: the sum stands, flagged rather than silent.
    expect(facts.fiberG.amount).toBe(4);
    expect(facts.fiberG.unmeasuredItems).toBe(1);
  });

  it('gives no percentage against a target nobody set', async () => {
    // A goal of 0 means unset. Dividing by it yields Infinity; reporting 0%
    // would be a different falsehood.
    const facts = factsFor(
      day({
        goal: { kcal: 1700, proteinG: 145, carbsG: 0, fatG: 0, fiberG: 35 },
        entries: [entry('breakfast', [nutrients(236, 37.5)])] as never,
      }),
    );

    expect(facts.carbsG.target).toBeNull();
    expect(facts.carbsG.percentOfTarget).toBeNull();
    expect(facts.remaining.carbsG).toBeNull();
  });

  it('reports going over target as over, not as zero left', async () => {
    const facts = factsFor(
      day({
        totals: {
          kcal: 1900,
          proteinG: 150,
          carbsG: 100,
          fatG: 40,
          fiberG: 20,
          carbsUnmeasuredItems: 0,
          fatUnmeasuredItems: 0,
          fiberUnmeasuredItems: 0,
        },
        entries: [entry('breakfast', [nutrients(236, 37.5)])] as never,
      }),
    );

    expect(facts.remaining.kcal).toBe(-200);
  });
});

describe('what the model is shown', () => {
  it('never asks the model to do arithmetic', () => {
    const facts = factsFor(
      day({ entries: [entry('breakfast', [nutrients(236, 37.5)])] as never }),
    );
    const turn = factsToUserTurn(facts);

    // Every figure it may use is present as a literal.
    expect(turn).toContain('236 kcal');
    expect(turn).toContain('37.5 g');
    expect(turn).toContain('26%');
    expect(turn).toContain('left');
  });

  it('spells out an unmeasured nutrient rather than omitting the line', () => {
    // An absent line invites the model to assume zero. The word is the guard.
    const facts = factsFor(
      day({ entries: [entry('breakfast', [nutrients(236, 37.5, { fiberG: null })])] as never }),
    );
    expect(factsToUserTurn(facts)).toContain('unmeasured');
  });

  it('says a target is unset rather than printing a zero target', () => {
    const facts = factsFor(
      day({
        goal: { kcal: 1700, proteinG: 145, carbsG: 0, fatG: 0, fiberG: 35 },
        entries: [entry('breakfast', [nutrients(236, 37.5)])] as never,
      }),
    );
    expect(factsToUserTurn(facts)).toContain('no target set');
  });
});
