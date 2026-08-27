import type { UserProfile } from '@nutricheck/contracts';
import {
  ageInYears,
  basalMetabolicRate,
  computeGoal,
} from '../goal-calculator';

const ON = new Date('2026-08-26T00:00:00Z');

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    sex: 'male',
    birthDate: '1991-01-01',
    heightCm: 180,
    weightKg: 80,
    activityLevel: 'moderate',
    objective: 'maintain',
    rateKgPerWeek: 0,
    units: 'metric',
    ...overrides,
  };
}

describe('ageInYears', () => {
  it('counts whole years', () => {
    expect(ageInYears('1991-01-01', ON)).toBe(35);
  });

  it('does not count a birthday that has not happened yet this year', () => {
    // Naive year subtraction is off by one here, which shifts BMR by 5 kcal.
    expect(ageInYears('1991-12-31', ON)).toBe(34);
  });

  it('counts the birthday itself', () => {
    expect(ageInYears('1991-08-26', ON)).toBe(35);
  });

  it('does not count the day before the birthday', () => {
    expect(ageInYears('1991-08-27', ON)).toBe(34);
  });

  it('never returns a negative age', () => {
    expect(ageInYears('2030-01-01', ON)).toBe(0);
  });
});

describe('basalMetabolicRate', () => {
  it('applies Mifflin-St Jeor for men', () => {
    // 10*80 + 6.25*180 - 5*35 + 5 = 1755
    expect(basalMetabolicRate('male', 80, 180, 35)).toBe(1755);
  });

  it('applies Mifflin-St Jeor for women', () => {
    // 10*65 + 6.25*165 - 5*30 - 161 = 1370.25
    expect(basalMetabolicRate('female', 65, 165, 30)).toBeCloseTo(1370.25, 2);
  });
});

describe('computeGoal', () => {
  it('sets calories at TDEE when maintaining', () => {
    const goal = computeGoal(profile(), ON);
    // 1755 BMR x 1.55 moderate = 2720.25
    expect(goal.basis.bmr).toBe(1755);
    expect(goal.basis.activityFactor).toBe(1.55);
    expect(goal.basis.tdee).toBe(2720);
    expect(goal.kcal).toBe(2720);
    expect(goal.basis.adjustmentPct).toBe(0);
    expect(goal.basis.flooredAtBmr).toBe(false);
  });

  it('subtracts the rate as a daily deficit when cutting', () => {
    // 0.25 kg/week x 7700 / 7 = 275 kcal/day, comfortably under the 20% cap.
    const goal = computeGoal(profile({ objective: 'lose', rateKgPerWeek: 0.25 }), ON);
    expect(goal.kcal).toBe(2445);
    expect(goal.basis.rateCapped).toBe(false);
    expect(goal.basis.effectiveRateKgPerWeek).toBe(0.25);
  });

  it('caps even a conventional 0.5 kg/week at a typical TDEE', () => {
    // 550 kcal/day is 20.2% of a 2720 kcal TDEE, so the cap bites on a rate
    // most people would consider unremarkable. The UI has to say so.
    const goal = computeGoal(profile({ objective: 'lose', rateKgPerWeek: 0.5 }), ON);
    expect(goal.basis.rateCapped).toBe(true);
    expect(goal.basis.effectiveRateKgPerWeek).toBeLessThan(0.5);
    expect(goal.kcal).toBe(2176);
  });

  it('does not report a cap when maintaining', () => {
    const goal = computeGoal(profile({ objective: 'maintain', rateKgPerWeek: 0 }), ON);
    expect(goal.basis.rateCapped).toBe(false);
    expect(goal.basis.effectiveRateKgPerWeek).toBe(0);
  });

  it('adds the rate when bulking', () => {
    const goal = computeGoal(profile({ objective: 'gain', rateKgPerWeek: 0.25 }), ON);
    // 0.25 x 7700 / 7 = 275
    expect(goal.kcal).toBe(2995);
    expect(goal.basis.adjustmentPct).toBeGreaterThan(0);
  });

  it('caps the adjustment at 20% of TDEE however aggressive the rate', () => {
    // 1.5 kg/week would be a 1650 kcal/day deficit — 61% of TDEE.
    const goal = computeGoal(profile({ objective: 'lose', rateKgPerWeek: 1.5 }), ON);
    expect(goal.basis.adjustmentPct).toBeCloseTo(-20, 5);
    expect(goal.kcal).toBe(Math.round(2720.25 * 0.8));
  });

  it('floors calories at BMR', () => {
    // A small, sedentary person on an aggressive cut: 20% off TDEE still lands
    // below BMR, and a target under BMR is not something to ship.
    const goal = computeGoal(
      profile({
        sex: 'female',
        weightKg: 48,
        heightCm: 155,
        activityLevel: 'sedentary',
        objective: 'lose',
        rateKgPerWeek: 1.0,
      }),
      ON,
    );

    expect(goal.basis.flooredAtBmr).toBe(true);
    expect(goal.kcal).toBe(goal.basis.bmr);
    expect(goal.kcal).toBeGreaterThanOrEqual(goal.basis.bmr);
  });

  it('reports the applied adjustment, not the requested one', () => {
    const goal = computeGoal(profile({ objective: 'lose', rateKgPerWeek: 3 }), ON);
    expect(goal.basis.adjustmentPct).toBeCloseTo(-20, 5);
  });

  it.each([
    ['sedentary', 1.2],
    ['light', 1.375],
    ['moderate', 1.55],
    // No 1.725. 'active' was dropped in 0007 and the remaining four keep the
    // standard figures -- the scale lost a rung, it was not rescaled.
    ['very_active', 1.9],
  ] as const)('uses the %s activity factor %p', (activityLevel, factor) => {
    const goal = computeGoal(profile({ activityLevel }), ON);
    expect(goal.basis.activityFactor).toBe(factor);
  });

  describe('protein', () => {
    it('scales with bodyweight and activity', () => {
      // moderate = 1.8 g/kg x 80 kg
      expect(computeGoal(profile(), ON).proteinG).toBe(144);
    });

    it('goes to the top of the range for very active users', () => {
      expect(computeGoal(profile({ activityLevel: 'very_active' }), ON).proteinG).toBe(176);
    });

    it('rises in a deficit to preserve lean mass', () => {
      const maintain = computeGoal(profile(), ON).proteinG;
      const cut = computeGoal(profile({ objective: 'lose', rateKgPerWeek: 0.5 }), ON).proteinG;
      expect(cut).toBeGreaterThan(maintain);
    });

    it('never exceeds 2.2 g/kg', () => {
      const goal = computeGoal(
        profile({ activityLevel: 'very_active', objective: 'lose', rateKgPerWeek: 0.5 }),
        ON,
      );
      expect(goal.proteinG).toBeLessThanOrEqual(Math.round(2.2 * 80));
    });
  });

  describe('fiber', () => {
    it('is 14 g per 1000 kcal', () => {
      const goal = computeGoal(profile(), ON);
      expect(goal.fiberG).toBe(Math.round((goal.kcal / 1000) * 14));
    });

    it('falls with the calorie target rather than staying fixed', () => {
      const maintain = computeGoal(profile(), ON);
      const cut = computeGoal(profile({ objective: 'lose', rateKgPerWeek: 0.5 }), ON);
      expect(cut.fiberG).toBeLessThan(maintain.fiberG);
    });
  });

  it('returns whole numbers — these are displayed targets, not intermediates', () => {
    const goal = computeGoal(profile({ weightKg: 73.4, heightCm: 171.5 }), ON);
    expect(Number.isInteger(goal.kcal)).toBe(true);
    expect(Number.isInteger(goal.proteinG)).toBe(true);
    expect(Number.isInteger(goal.fiberG)).toBe(true);
  });
});
