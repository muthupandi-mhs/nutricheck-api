import type { Nutrients } from '@nutricheck/contracts';
import {
  computeItemNutrients,
  gramsForPortion,
  sumDay,
  type Per100g,
} from '../nutrition-calculator';

const lentils: Per100g = {
  kcal: 116,
  proteinG: 9.02,
  fiberG: 7.9,
  fiberState: 'known',
};

const chicken: Per100g = {
  kcal: 120,
  proteinG: 22.5,
  fiberG: null,
  fiberState: 'unknown',
};

describe('computeItemNutrients', () => {
  it('scales per-100g values by the portion', () => {
    expect(computeItemNutrients(lentils, 198)).toEqual({
      kcal: 229.68,
      proteinG: 17.86,
      fiberG: 15.64,
      fiberState: 'known',
    });
  });

  it('is the identity at exactly 100 g', () => {
    expect(computeItemNutrients(lentils, 100)).toEqual({
      kcal: 116,
      proteinG: 9.02,
      fiberG: 7.9,
      fiberState: 'known',
    });
  });

  it('keeps unknown fiber null rather than multiplying it into a number', () => {
    // Multiplying a missing measurement by a portion does not measure it.
    const result = computeItemNutrients(chicken, 180);
    expect(result.fiberG).toBeNull();
    expect(result.fiberState).toBe('unknown');
    expect(result.kcal).toBe(216);
  });

  it('carries the imputed state through unchanged', () => {
    // Imputed fiber is displayed with a "~". It must not silently become known
    // just because it survived the arithmetic.
    const imputed: Per100g = { kcal: 250, proteinG: 8, fiberG: 5, fiberState: 'imputed' };
    expect(computeItemNutrients(imputed, 50)).toEqual({
      kcal: 125,
      proteinG: 4,
      fiberG: 2.5,
      fiberState: 'imputed',
    });
  });

  it('preserves a known zero', () => {
    const egg: Per100g = { kcal: 155, proteinG: 12.58, fiberG: 0, fiberState: 'known' };
    const result = computeItemNutrients(egg, 50);
    expect(result.fiberG).toBe(0);
    expect(result.fiberState).toBe('known');
  });

  it('rounds to two decimals so stored values do not drift', () => {
    const awkward: Per100g = { kcal: 33.333, proteinG: 1.111, fiberG: 0.777, fiberState: 'known' };
    expect(computeItemNutrients(awkward, 33)).toEqual({
      kcal: 11,
      proteinG: 0.37,
      fiberG: 0.26,
      fiberState: 'known',
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a non-positive or non-finite portion (%p)',
    (grams) => {
      expect(() => computeItemNutrients(lentils, grams)).toThrow(RangeError);
    },
  );

  it('treats a null fiberG with a non-unknown state as unmeasured', () => {
    // Defensive: the contract forbids this pairing, but a bad ingest could
    // produce it and the arithmetic must not read null as zero.
    const inconsistent: Per100g = { kcal: 100, proteinG: 1, fiberG: null, fiberState: 'known' };
    expect(computeItemNutrients(inconsistent, 200).fiberG).toBeNull();
  });
});

describe('sumDay', () => {
  const known = (kcal: number, proteinG: number, fiberG: number): Nutrients => ({
    kcal,
    proteinG,
    fiberG,
    fiberState: 'known',
  });

  it('returns zeroes for an empty day', () => {
    expect(sumDay([])).toEqual({
      kcal: 0,
      proteinG: 0,
      fiberG: 0,
      fiberUnmeasuredItems: 0,
    });
  });

  it('adds up a day', () => {
    expect(sumDay([known(200, 10, 4), known(350, 22, 6)])).toEqual({
      kcal: 550,
      proteinG: 32,
      fiberG: 10,
      fiberUnmeasuredItems: 0,
    });
  });

  it('excludes unknown fiber from the sum and counts it instead', () => {
    // This is what lets the ring say "8 g of 28 g, 2 items unmeasured" rather
    // than quietly claiming a number it does not have.
    const totals = sumDay([
      known(200, 10, 8),
      { kcal: 216, proteinG: 40.5, fiberG: null, fiberState: 'unknown' },
      { kcal: 300, proteinG: 30, fiberG: null, fiberState: 'unknown' },
    ]);

    expect(totals.fiberG).toBe(8);
    expect(totals.fiberUnmeasuredItems).toBe(2);
    // Calories and protein are unaffected — only fiber has the three-state rule.
    expect(totals.kcal).toBe(716);
    expect(totals.proteinG).toBe(80.5);
  });

  it('counts imputed fiber towards the total', () => {
    const totals = sumDay([
      known(100, 5, 3),
      { kcal: 100, proteinG: 5, fiberG: 2, fiberState: 'imputed' },
    ]);
    expect(totals.fiberG).toBe(5);
    expect(totals.fiberUnmeasuredItems).toBe(0);
  });

  it('does not accumulate floating point drift', () => {
    const items = Array.from({ length: 300 }, () => known(0.1, 0.1, 0.1));
    const totals = sumDay(items);
    expect(totals.kcal).toBe(30);
    expect(totals.fiberG).toBe(30);
  });
});

describe('gramsForPortion', () => {
  const portions = [
    { label: '1 medium (approx 3 per lb)', grams: 182 },
    { label: '1 cup', grams: 158 },
  ];

  it('resolves a household unit to grams', () => {
    expect(gramsForPortion(portions, '1 cup')).toBe(158);
  });

  it('multiplies by the count', () => {
    expect(gramsForPortion(portions, '1 cup', 2)).toBe(316);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(gramsForPortion(portions, '  1 CUP ')).toBe(158);
  });

  it('returns null for an unknown unit rather than guessing', () => {
    // "Some nuts" specifies nothing. Asking costs one tap; guessing costs trust.
    expect(gramsForPortion(portions, '1 handful')).toBeNull();
  });

  it('returns null when the food has no portions at all', () => {
    expect(gramsForPortion([], '1 cup')).toBeNull();
  });
});
