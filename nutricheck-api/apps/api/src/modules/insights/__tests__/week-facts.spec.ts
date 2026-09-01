import {
  ON_TARGET_TOLERANCE,
  type DayPoint,
  type WeekSummary,
  type WeightTrend,
} from '@nutricheck/contracts';
import { isOnTarget, weekFactsOf } from '../week-facts';
import { weekFactsToUserTurn } from '../../ai/week-review-input';

/**
 * The arithmetic behind a weekly review.
 *
 * The half the model is not allowed to do, and therefore the half that has to
 * be right. Every case here is a way the review could state something false
 * while reading perfectly well — an unlogged day counted as a bad one, an
 * average of two days described as the week, a "furthest day" with the
 * direction quietly lost.
 */

const GOAL = { kcal: 2000, proteinG: 145, carbsG: 200, fatG: 60, fiberG: 35 };

const point = (date: string, kcal: number, logged = true): DayPoint => ({
  date,
  kcal,
  proteinG: 100,
  carbsG: 180,
  fatG: 55,
  fiberG: 30,
  logged,
});

/** Averages are supplied the way `LogsService.week` supplies them: over logged days. */
const week = (days: DayPoint[], over: Partial<WeekSummary> = {}): WeekSummary => {
  const logged = days.filter(d => d.logged);
  const mean = (pick: (d: DayPoint) => number) =>
    logged.length === 0 ? 0 : logged.reduce((a, d) => a + pick(d), 0) / logged.length;

  return {
    from: days[0]!.date,
    to: days[days.length - 1]!.date,
    days,
    goal: GOAL,
    averages: {
      kcal: mean(d => d.kcal),
      proteinG: mean(d => d.proteinG),
      carbsG: mean(d => d.carbsG),
      fatG: mean(d => d.fatG),
      fiberG: mean(d => d.fiberG),
    },
    streakDays: logged.length,
    ...over,
  } as WeekSummary;
};

/** Seven consecutive days from 2026-08-24. `null` is a day nobody logged. */
const sevenDays = (kcals: (number | null)[]): DayPoint[] =>
  kcals.map((k, i) => point(`2026-08-${String(24 + i).padStart(2, '0')}`, k ?? 0, k !== null));

const empty = week(sevenDays([null, null, null, null, null, null, null]));

describe('what the week covers', () => {
  it('counts logged days, and does not treat an unlogged day as a zero-calorie one', () => {
    const facts = weekFactsOf(
      week(sevenDays([2000, null, 2100, null, 1900, 2000, null])),
      empty,
      null,
    );

    expect(facts.loggedDays).toBe(4);
    // The average is over the four, so it sits on target. Over seven it would
    // be ~1,143 and the review would report a starvation week that never was.
    expect(facts.kcal.average).toBe(2000);
  });

  it('reports null averages rather than zeroes when nothing was logged', () => {
    const facts = weekFactsOf(empty, empty, null);

    expect(facts.loggedDays).toBe(0);
    expect(facts.kcal.average).toBeNull();
    expect(facts.kcal.deltaFromTarget).toBeNull();
    expect(facts.closestDay).toBeNull();
    expect(facts.furthestDay).toBeNull();
    // The target still stands. It was set; it was simply not eaten against.
    expect(facts.kcal.target).toBe(2000);
  });

  it('keeps a genuine zero-calorie day as zero, not as an absence', () => {
    const days = sevenDays([null, null, null, null, null, null, null]);
    days[0] = point('2026-08-24', 0, true);
    const facts = weekFactsOf(week(days), empty, null);

    expect(facts.loggedDays).toBe(1);
    // A week of black coffee is a real and slightly alarming figure. Reporting
    // it as "no data" would hide the one week most worth seeing.
    expect(facts.kcal.average).toBe(0);
    expect(facts.kcal.deltaFromTarget).toBe(-2000);
  });
});

describe('on target', () => {
  it('costs the same in both directions', () => {
    // 2,300 and 1,700 are both 300 off a 2,000 target — 15%, the boundary.
    expect(isOnTarget(point('d', 2300), 2000)).toBe(true);
    expect(isOnTarget(point('d', 1700), 2000)).toBe(true);
    expect(isOnTarget(point('d', 2301), 2000)).toBe(false);
    expect(isOnTarget(point('d', 1699), 2000)).toBe(false);
  });

  /**
   * The rule this whole feature has to keep. The mobile history calendar paints
   * a day green at exactly this distance; a review that called the same day on
   * target at a different threshold would leave the user with two screens and
   * no way to tell which one to believe.
   */
  it('uses the same tolerance the history calendar paints with', () => {
    expect(ON_TARGET_TOLERANCE).toBe(0.15);
  });

  it('counts no day as on target when there is no target', () => {
    const facts = weekFactsOf(
      week(sevenDays([2000, 2000, 2000, 2000, 2000, 2000, 2000]), {
        goal: { ...GOAL, kcal: 0 },
      }),
      empty,
      null,
    );

    // A goal of 0 is "not set", not "a target of zero". Counting seven days as
    // on target against it would be a perfect week nobody had.
    expect(facts.onTargetDays).toBe(0);
    expect(facts.kcal.target).toBeNull();
    expect(facts.kcal.percentOfTarget).toBeNull();
  });

  it('counts only logged days', () => {
    const facts = weekFactsOf(
      week(sevenDays([2000, null, 2050, null, 3000, null, null])),
      empty,
      null,
    );

    expect(facts.loggedDays).toBe(3);
    expect(facts.onTargetDays).toBe(2);
  });
});

describe('the days singled out', () => {
  it('keeps the direction on the furthest day', () => {
    const facts = weekFactsOf(
      week(sevenDays([2000, 1980, 900, 2100, null, null, null])),
      empty,
      null,
    );

    expect(facts.closestDay?.date).toBe('2026-08-24');
    expect(facts.furthestDay?.date).toBe('2026-08-26');
    // Negative is under. Without the sign the model has to guess which way, and
    // it would guess.
    expect(facts.furthestDay?.offByKcal).toBe(-1100);
  });

  it('is symmetric — an overshoot can be the furthest day too', () => {
    const facts = weekFactsOf(
      week(sevenDays([2000, 3200, null, null, null, null, null])),
      empty,
      null,
    );

    expect(facts.furthestDay?.offByKcal).toBe(1200);
  });

  it('names the same day twice when only one was logged, and says so', () => {
    const facts = weekFactsOf(
      week(sevenDays([null, 1500, null, null, null, null, null])),
      empty,
      null,
    );

    expect(facts.closestDay?.date).toBe('2026-08-25');
    expect(facts.furthestDay?.date).toBe('2026-08-25');
    // The renderer has to explain it, or the model writes about two days.
    expect(weekFactsToUserTurn(facts)).toContain('only one day was logged');
  });
});

describe('the week before', () => {
  it('reports no comparison rather than an average of nothing', () => {
    const facts = weekFactsOf(
      week(sevenDays([2000, 2000, null, null, null, null, null])),
      empty,
      null,
    );

    expect(facts.previous.loggedDays).toBe(0);
    expect(facts.previous.kcalAverage).toBeNull();
    expect(weekFactsToUserTurn(facts)).toContain('there is no comparison to make');
  });

  it('carries the previous week average when there is one', () => {
    const before = week(sevenDays([2300, 2320, 2310, null, null, null, null]));
    const facts = weekFactsOf(
      week(sevenDays([2000, 2000, null, null, null, null, null])),
      before,
      null,
    );

    expect(facts.previous.loggedDays).toBe(3);
    expect(facts.previous.kcalAverage).toBe(2310);
  });
});

describe('what the model is handed', () => {
  const trend: WeightTrend = {
    kgPerWeek: -0.4,
    deltaKg: -1.6,
    spanDays: 28,
    intendedKgPerWeek: -0.5,
  };

  const twoDays = () => week(sevenDays([2000, 2000, null, null, null, null, null]));

  it('says which days the averages cover, before it says what they are', () => {
    const turn = weekFactsToUserTurn(weekFactsOf(twoDays(), empty, null));

    expect(turn).toContain('Days logged: 2 of 7');
    expect(turn).toContain('NOT across seven');
    // Reading order is the instruction: the count has to arrive before the
    // figures it qualifies.
    expect(turn.indexOf('Days logged')).toBeLessThan(turn.indexOf('Daily averages'));
  });

  it('names deltas in words, never as a bare sign', () => {
    const w = twoDays();
    w.averages.proteinG = 100;
    const turn = weekFactsToUserTurn(weekFactsOf(w, empty, null));

    // "45 g under target" cannot be read backwards. "-45" can.
    expect(turn).toContain('45 g under target');
  });

  it('omits weight entirely when there is no trend', () => {
    const turn = weekFactsToUserTurn(weekFactsOf(twoDays(), empty, null));

    // Not "not weighed", not "no trend available" — nothing. The prompt forbids
    // remarking on its absence, and the surest way to hold a model to that is
    // to give it nothing on the subject to react to.
    expect(turn.toLowerCase()).not.toContain('weight');
    expect(turn.toLowerCase()).not.toContain('scale');
  });

  it('states the trend as a rate, not as a change during the week', () => {
    const turn = weekFactsToUserTurn(weekFactsOf(twoDays(), empty, trend));

    expect(turn).toContain('-0.40 kg per week');
    expect(turn).toContain('Intended rate: -0.50 kg per week');
    // The fit is over 28 days; saying it happened "this week" would be a claim
    // the data does not carry.
    expect(turn).toContain('NOT how much they moved during this week');
  });

  it('says there is no intended rate for somebody maintaining', () => {
    const turn = weekFactsToUserTurn(
      weekFactsOf(twoDays(), empty, { ...trend, intendedKgPerWeek: null }),
    );

    // Not "0.00 kg per week". No intended rate and an intended rate of zero
    // read the same as a number and differently as a sentence.
    expect(turn).toContain('there is no rate to miss');
  });
});
