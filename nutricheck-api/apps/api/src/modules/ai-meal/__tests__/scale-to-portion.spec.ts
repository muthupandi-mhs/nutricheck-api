import { scaleToPortion } from '../ai-meal.service';
import type { AiMealItem } from '../../ai/ai.schemas';

/**
 * The corpus-free path lets a model supply nutrition, which every other part of
 * this system forbids. The single thing that makes that bearable is that the
 * model supplies RATES and the multiplication happens here — so this is the
 * test that the bargain is actually kept.
 */
function item(over: Partial<AiMealItem> = {}): AiMealItem & { date: string | null } {
  return {
    name: 'Dosai, plain',
    spokenAs: 'dosai',
    quantity: 5,
    unit: 'dosai',
    grams: 300,
    per100g: { kcal: 168, proteinG: 3.9, carbsG: 27.4, fatG: 5.5, fiberG: 1.2 },
    confidence: 'high',
    quantityStated: true,
    meal: null,
    date: null,
    ...over,
  };
}

describe('scaleToPortion', () => {
  it('multiplies the rate by the grams rather than trusting a total', () => {
    const scaled = scaleToPortion(item());

    // 168 kcal/100 g over 300 g. Five dosai, the worked example.
    expect(scaled.kcal).toBe(504);
    expect(scaled.proteinG).toBe(11.7);
    expect(scaled.carbsG).toBe(82.2);
    expect(scaled.fatG).toBe(16.5);
    expect(scaled.fiberG).toBe(3.6);
  });

  it('scales below 100 g without treating the rate as the answer', () => {
    // The failure this guards: a 30 g side of chutney reported as a full
    // 100 g of it, which is the shape of mistake nobody notices because the
    // number is plausible either way.
    const scaled = scaleToPortion(
      item({
        name: 'Coconut chutney',
        quantity: 1,
        unit: 'serving',
        grams: 30,
        per100g: { kcal: 190, proteinG: 3, carbsG: 6, fatG: 17, fiberG: 3 },
      }),
    );

    expect(scaled.kcal).toBe(57);
    expect(scaled.fatG).toBe(5.1);
  });

  it('keeps quantity and unit as the person counted them', () => {
    // "rendu muttai" is two eggs. The grams are ours to use; the unit is what
    // the user has to recognise on a confirmation screen before tapping add.
    const scaled = scaleToPortion(
      item({ name: 'Egg, boiled', spokenAs: 'muttai', quantity: 2, unit: 'egg', grams: 100 }),
    );

    expect(scaled.quantity).toBe(2);
    expect(scaled.unit).toBe('egg');
    expect(scaled.spokenAs).toBe('muttai');
  });

  it('carries low confidence through untouched', () => {
    // An assumed portion must stay flagged all the way to the screen. Rounding
    // a number does not make it better known than it was.
    const scaled = scaleToPortion(item({ confidence: 'low' }));
    expect(scaled.confidence).toBe('low');
  });

  it('rounds to one decimal, because these are estimates', () => {
    const scaled = scaleToPortion(
      item({ grams: 37, per100g: { kcal: 168, proteinG: 3.9, carbsG: 27.4, fatG: 5.5, fiberG: 1.2 } }),
    );

    // 168 * 0.37 = 62.16
    expect(scaled.kcal).toBe(62.2);
    expect(Number.isInteger(scaled.kcal * 10)).toBe(true);
  });
});
