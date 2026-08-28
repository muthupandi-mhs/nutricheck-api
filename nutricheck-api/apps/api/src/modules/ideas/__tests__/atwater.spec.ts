import type { IdeaItem } from '../../ai/ai.schemas';
import { atwaterCheck, fibreIsPossible } from '../atwater';
import { mealSlotFor, scaleIdea } from '../ideas.service';

/**
 * The arithmetic on the ideas path.
 *
 * These three functions are the whole of what can be proven correct about a
 * feature whose inputs are recalled by a model. Everything else about it is
 * reviewed; this is checked.
 */

function idea(per100g: IdeaItem['per100g'], rest: Partial<IdeaItem> = {}): IdeaItem {
  return {
    name: 'Curd, plain',
    reason: 'Covers a third of the protein you have left.',
    servingLabel: '1 cup',
    grams: 200,
    per100g,
    confidence: 'high',
    ...rest,
  };
}

describe('the Atwater check', () => {
  it('passes food whose calories follow from its own macros', () => {
    // Boiled egg, roughly: 13 x 4 + 1 x 4 + 11 x 9 = 155.
    const result = atwaterCheck(
      idea({ kcal: 155, proteinG: 13, carbsG: 1, fatG: 11, fiberG: 0 }),
    );

    expect(result.ok).toBe(true);
    expect(result.impliedKcal).toBe(155);
  });

  it('passes a high-fibre food, whose sum legitimately overshoots', () => {
    // Cooked chana: fibre is counted inside carbohydrate but yields about 2
    // kcal per gram rather than 4, so the flat 4/4/9 sum runs high. This is the
    // case a tighter tolerance would refuse, and it is a correct answer.
    const result = atwaterCheck(
      idea({ kcal: 164, proteinG: 8.9, carbsG: 27.4, fatG: 2.6, fiberG: 7.6 }),
    );

    expect(result.impliedKcal).toBeGreaterThan(164);
    expect(result.ok).toBe(true);
  });

  it('drops a figure that was never derived from the macros beside it', () => {
    // 250 kcal claimed; the macros account for 90. One of the two is invented
    // and there is no way to tell which, so the item does not survive.
    const result = atwaterCheck(
      idea({ kcal: 250, proteinG: 5, carbsG: 10, fatG: 3, fiberG: 2 }),
    );

    expect(result.ok).toBe(false);
    expect(result.impliedKcal).toBe(87);
  });

  it('does not punish a near-zero food for a percentage swing', () => {
    // Cucumber. 12 stated against 8 implied is a 33% difference and entirely
    // ordinary at this scale — percentages of a tiny denominator mean nothing.
    const result = atwaterCheck(
      idea({ kcal: 12, proteinG: 0.7, carbsG: 1.1, fatG: 0.1, fiberG: 0.5 }),
    );

    expect(result.ok).toBe(true);
  });

  it('still refuses a small figure that is absolutely far out', () => {
    const result = atwaterCheck(
      idea({ kcal: 35, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }),
    );

    expect(result.ok).toBe(false);
  });
});

describe('the fibre check', () => {
  it('accepts fibre that is part of the carbohydrate', () => {
    expect(
      fibreIsPossible(idea({ kcal: 164, proteinG: 8.9, carbsG: 27.4, fatG: 2.6, fiberG: 7.6 })),
    ).toBe(true);
  });

  it('refuses more fibre than carbohydrate, which is not a food', () => {
    expect(
      fibreIsPossible(idea({ kcal: 120, proteinG: 4, carbsG: 9, fatG: 2, fiberG: 18 })),
    ).toBe(false);
  });
});

describe('scaling a suggested serving', () => {
  it('multiplies the rates by the grams, and carries nothing else through', () => {
    const scaled = scaleIdea(
      idea(
        { kcal: 98, proteinG: 11, carbsG: 3.4, fatG: 4.3, fiberG: 0 },
        { grams: 200, servingLabel: '1 cup' },
      ),
    );

    expect(scaled.kcal).toBe(196);
    expect(scaled.proteinG).toBe(22);
    expect(scaled.carbsG).toBe(6.8);
    expect(scaled.fatG).toBe(8.6);
    expect(scaled.grams).toBe(200);
    expect(scaled.servingLabel).toBe('1 cup');
  });

  it('rounds to one decimal — these are estimates', () => {
    const scaled = scaleIdea(
      idea({ kcal: 164, proteinG: 8.9, carbsG: 27.4, fatG: 2.6, fiberG: 7.6 }, { grams: 165 }),
    );

    expect(scaled.kcal).toBe(270.6);
    expect(scaled.proteinG).toBe(14.7);
  });
});

describe('which meal the clock is in', () => {
  /** 14:30 UTC — 20:00 in Kolkata, mid-afternoon in London. */
  const afternoonUtc = new Date('2026-08-28T14:30:00.000Z');

  it("reads the hour in the user's zone, not the server's", () => {
    expect(mealSlotFor(afternoonUtc, 'Asia/Kolkata')).toBe('dinner');
    expect(mealSlotFor(afternoonUtc, 'UTC')).toBe('lunch');
  });

  it('falls back to UTC for a zone it cannot read, rather than failing the tab', () => {
    expect(mealSlotFor(afternoonUtc, 'Not/AZone')).toBe('lunch');
  });

  it('puts a late evening in the snack slot', () => {
    // 17:00 UTC is 22:30 in Kolkata.
    expect(mealSlotFor(new Date('2026-08-28T17:00:00.000Z'), 'Asia/Kolkata')).toBe('snack');
  });

  it('treats midnight as breakfast, whichever hour ICU reports for it', () => {
    // 18:30 UTC is exactly 00:00 in Kolkata — the case where 'hour12: false'
    // returns 24 rather than 0 on some ICU builds, and both have to land here.
    expect(mealSlotFor(new Date('2026-08-28T18:30:00.000Z'), 'Asia/Kolkata')).toBe('breakfast');
  });
});
