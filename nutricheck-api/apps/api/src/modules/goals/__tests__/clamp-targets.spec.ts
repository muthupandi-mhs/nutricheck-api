import type { UserProfile } from '@nutricheck/contracts';
import { clampTargets } from '../clamp-targets';
import { computeGoal } from '../goal-calculator';

/**
 * The guard between a model's opinion and somebody's diet.
 *
 * This is the only thing standing between a confidently wrong number and a
 * target a person eats to for months, so it is tested against the numbers a
 * model would plausibly return rather than only against absurd ones. The
 * dangerous case is not 50,000 kcal — nobody would act on that. It is 1,200
 * for a large man, which looks entirely reasonable and is under what he burns
 * lying still.
 */
const ON = new Date('2026-08-28T00:00:00.000Z');

function profile(over: Partial<UserProfile> = {}): UserProfile {
  return {
    sex: 'male',
    birthDate: '1996-08-28',
    heightCm: 180,
    weightKg: 85,
    activityLevel: 'moderate',
    objective: 'lose',
    rateKgPerWeek: 0.5,
    ...over,
  } as UserProfile;
}

describe('clampTargets', () => {
  const p = profile();
  const derived = computeGoal(p, ON);

  it('leaves a sensible suggestion alone', () => {
    const out = clampTargets(
      { kcal: derived.kcal - 40, proteinG: derived.proteinG, fiberG: derived.fiberG },
      p,
      derived,
    );

    expect(out.kcal).toBe(derived.kcal - 40);
    expect(out.corrections).toEqual([]);
  });

  it('will not let calories go under resting burn', () => {
    // The plausible-looking failure: a round number, well below what this body
    // spends at rest, which no amount of reading the figure would reveal.
    const out = clampTargets(
      { kcal: 1200, proteinG: derived.proteinG, fiberG: derived.fiberG },
      p,
      derived,
    );

    expect(out.kcal).toBe(derived.basis.bmr);
    expect(out.corrections[0]).toContain('resting burn');
  });

  it('caps protein against bodyweight, not against a fixed number', () => {
    const light = profile({ weightKg: 45 });
    const lightGoal = computeGoal(light, ON);

    // 150 g is unremarkable at 85 kg and past the useful range at 45.
    const out = clampTargets({ kcal: lightGoal.kcal, proteinG: 150, fiberG: 25 }, light, lightGoal);

    expect(out.proteinG).toBe(Math.round(45 * 2.4));
    expect(out.corrections.some(c => c.includes('Protein'))).toBe(true);
  });

  it('raises protein that is too low to be safe', () => {
    const out = clampTargets({ kcal: derived.kcal, proteinG: 20, fiberG: 25 }, p, derived);

    expect(out.proteinG).toBe(Math.round(85 * 0.8));
    expect(out.corrections.some(c => c.includes('Protein'))).toBe(true);
  });

  it('bounds fibre at both ends', () => {
    const low = clampTargets({ kcal: derived.kcal, proteinG: derived.proteinG, fiberG: 2 }, p, derived);
    const high = clampTargets({ kcal: derived.kcal, proteinG: derived.proteinG, fiberG: 200 }, p, derived);

    expect(low.fiberG).toBe(10);
    expect(high.fiberG).toBe(70);
  });

  it('reports every figure it moved, so the screen can say so', () => {
    const out = clampTargets({ kcal: 500, proteinG: 5, fiberG: 200 }, p, derived);

    // Three corrections, not one summary. A user told "we adjusted your
    // targets" learns nothing; told which three and why, they can disagree.
    expect(out.corrections).toHaveLength(3);
  });

  it('returns whole numbers, whatever it was given', () => {
    const out = clampTargets(
      { kcal: 2140.6, proteinG: 131.4, fiberG: 29.5 },
      p,
      derived,
    );

    expect(Number.isInteger(out.kcal)).toBe(true);
    expect(Number.isInteger(out.proteinG)).toBe(true);
    expect(Number.isInteger(out.fiberG)).toBe(true);
  });
});
