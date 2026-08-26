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
  carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
    fiberG: 7.9,
  fiberState: 'known',
};

const chicken: Per100g = {
  kcal: 120,
  proteinG: 22.5,
  carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
    fiberG: null,
  fiberState: 'unknown',
};

describe('computeItemNutrients', () => {
  it('scales per-100g values by the portion', () => {
    expect(computeItemNutrients(lentils, 198)).toEqual({
      kcal: 229.68,
      proteinG: 17.86,
      carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
    fiberG: 15.64,
      fiberState: 'known',
    });
  });

  it('is the identity at exactly 100 g', () => {
    expect(computeItemNutrients(lentils, 100)).toEqual({
      kcal: 116,
      proteinG: 9.02,
      carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
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
    const imputed: Per100g = { kcal: 250, proteinG: 8, carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
    fiberG: 5, fiberState: 'imputed' };
    expect(computeItemNutrients(imputed, 50)).toEqual({
      kcal: 125,
      proteinG: 4,
      carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
    fiberG: 2.5,
      fiberState: 'imputed',
    });
  });

  it('preserves a known zero', () => {
    const egg: Per100g = { kcal: 155, proteinG: 12.58, carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
    fiberG: 0, fiberState: 'known' };
    const result = computeItemNutrients(egg, 50);
    expect(result.fiberG).toBe(0);
    expect(result.fiberState).toBe('known');
  });

  it('rounds to two decimals so stored values do not drift', () => {
    const awkward: Per100g = { kcal: 33.333, proteinG: 1.111, carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
    fiberG: 0.777, fiberState: 'known' };
    expect(computeItemNutrients(awkward, 33)).toEqual({
      kcal: 11,
      proteinG: 0.37,
      carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
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
    const inconsistent: Per100g = { kcal: 100, proteinG: 1, carbsG: null,
    carbsState: 'unknown',
    fatG: null,
    fatState: 'unknown',
    fiberG: null, fiberState: 'known' };
    expect(computeItemNutrients(inconsistent, 200).fiberG).toBeNull();
  });
});


describe('sumDay', () => {
  /** Everything measured. The ordinary case. */
  const known = (
    kcal: number,
    proteinG: number,
    fiberG: number,
    carbsG = 0,
    fatG = 0,
  ): Nutrients => ({
    kcal,
    proteinG,
    carbsG,
    carbsState: 'known',
    fatG,
    fatState: 'known',
    fiberG,
    fiberState: 'known',
  });

  /** One nutrient missing, the rest measured — the shape a real corpus gap has. */
  const missing = (
    kcal: number,
    proteinG: number,
    absent: 'carbs' | 'fat' | 'fiber',
  ): Nutrients => ({
    kcal,
    proteinG,
    carbsG: absent === 'carbs' ? null : 10,
    carbsState: absent === 'carbs' ? 'unknown' : 'known',
    fatG: absent === 'fat' ? null : 5,
    fatState: absent === 'fat' ? 'unknown' : 'known',
    fiberG: absent === 'fiber' ? null : 2,
    fiberState: absent === 'fiber' ? 'unknown' : 'known',
  });

  it('returns zeroes for an empty day', () => {
    expect(sumDay([])).toEqual({
      kcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      fiberG: 0,
      carbsUnmeasuredItems: 0,
      fatUnmeasuredItems: 0,
      fiberUnmeasuredItems: 0,
    });
  });

  it('adds up a day', () => {
    expect(sumDay([known(200, 10, 4, 30, 6), known(350, 22, 6, 40, 9)])).toEqual({
      kcal: 550,
      proteinG: 32,
      carbsG: 70,
      fatG: 15,
      fiberG: 10,
      carbsUnmeasuredItems: 0,
      fatUnmeasuredItems: 0,
      fiberUnmeasuredItems: 0,
    });
  });

  it('excludes an unknown from its own sum and counts it instead', () => {
    // This is what lets the ring say "8 g of 28 g, 2 items unmeasured" rather
    // than quietly claiming a number it does not have.
    const totals = sumDay([
      known(200, 10, 8, 20, 4),
      missing(216, 40.5, 'fiber'),
      missing(300, 30, 'fiber'),
    ]);

    expect(totals.fiberG).toBe(8);
    expect(totals.fiberUnmeasuredItems).toBe(2);
    // Calories and protein are never nullable, so they are unaffected.
    expect(totals.kcal).toBe(716);
    expect(totals.proteinG).toBe(80.5);
  });

  it('counts each nutrient gap separately, not with one shared counter', () => {
    // The item missing fibre is usually not the item missing carbs. A single
    // count could not say which total to distrust.
    const totals = sumDay([
      missing(100, 5, 'carbs'),
      missing(100, 5, 'fat'),
      missing(100, 5, 'fiber'),
    ]);

    expect(totals.carbsUnmeasuredItems).toBe(1);
    expect(totals.fatUnmeasuredItems).toBe(1);
    expect(totals.fiberUnmeasuredItems).toBe(1);
    // Each sum still includes the two items that DID report that nutrient.
    expect(totals.carbsG).toBe(20);
    expect(totals.fatG).toBe(10);
    expect(totals.fiberG).toBe(4);
  });

  it('counts imputed values towards the total', () => {
    // 'imputed' is a real value from an estimate, not a missing one. Curated
    // dishes are imputed throughout and must still add up.
    const totals = sumDay([
      known(100, 5, 3, 10, 2),
      {
        kcal: 100,
        proteinG: 5,
        carbsG: 12,
        carbsState: 'imputed',
        fatG: 3,
        fatState: 'imputed',
        fiberG: 2,
        fiberState: 'imputed',
      },
    ]);
    expect(totals.fiberG).toBe(5);
    expect(totals.carbsG).toBe(22);
    expect(totals.fatG).toBe(5);
    expect(totals.fiberUnmeasuredItems).toBe(0);
    expect(totals.carbsUnmeasuredItems).toBe(0);
  });

  it('does not accumulate floating point drift', () => {
    const items = Array.from({ length: 300 }, () => known(0.1, 0.1, 0.1, 0.1, 0.1));
    const totals = sumDay(items);
    expect(totals.kcal).toBe(30);
    expect(totals.fiberG).toBe(30);
    expect(totals.carbsG).toBe(30);
    expect(totals.fatG).toBe(30);
  });
});
