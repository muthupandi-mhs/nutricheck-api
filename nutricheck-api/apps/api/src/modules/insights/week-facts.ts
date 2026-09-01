import {
  ON_TARGET_TOLERANCE,
  type DayPoint,
  type WeekAverage,
  type WeekDayMark,
  type WeekFacts,
  type WeekSummary,
  type WeightTrend,
} from '@nutricheck/contracts';

/**
 * The week, reduced to the figures a review may mention.
 *
 * A pure function over the same `WeekSummary` the charts are drawn from, in its
 * own file so it can be tested without a database, a model or a cache — which
 * matters more here than for most helpers, because everything downstream of it
 * is prose and prose cannot be asserted on.
 *
 * Nothing in here recomputes a total. `logs.week()` has already summed the days
 * from frozen log values; this only folds those sums into averages, deltas and
 * counts. A second summation would be a second place for the review and the
 * bars underneath it to disagree, and the disagreement would be invisible —
 * both would look plausible.
 */
export function weekFactsOf(
  week: WeekSummary,
  previous: WeekSummary,
  weight: WeightTrend | null,
): WeekFacts {
  const logged = week.days.filter((day) => day.logged);
  const previousLogged = previous.days.filter((day) => day.logged);

  return {
    from: week.from,
    to: week.to,
    loggedDays: logged.length,
    streakDays: week.streakDays,
    onTargetDays: logged.filter((day) => isOnTarget(day, week.goal.kcal)).length,
    kcal: averageOf(week.averages.kcal, week.goal.kcal, logged.length, 0),
    proteinG: averageOf(week.averages.proteinG, week.goal.proteinG, logged.length, 1),
    carbsG: averageOf(week.averages.carbsG, week.goal.carbsG, logged.length, 1),
    fatG: averageOf(week.averages.fatG, week.goal.fatG, logged.length, 1),
    fiberG: averageOf(week.averages.fiberG, week.goal.fiberG, logged.length, 1),
    closestDay: pickDay(logged, week.goal.kcal, 'closest'),
    furthestDay: pickDay(logged, week.goal.kcal, 'furthest'),
    weight,
    previous: {
      loggedDays: previousLogged.length,
      kcalAverage: previousLogged.length > 0 ? round(previous.averages.kcal, 0) : null,
    },
  };
}

/**
 * Did this day land close enough to the calorie target to count?
 *
 * Symmetric, and the same tolerance the history calendar paints with — see
 * `ON_TARGET_TOLERANCE`. Exported because the test asserts on it directly: this
 * is the one rule in the file that a reader has to be able to check against the
 * other screen without following it through three call sites.
 *
 * A target of zero means "no target set", not "a target of zero", so no day can
 * be on target against it. Returning true would count every unlogged-goal day
 * as a success; returning false is the honest reading and the review's count
 * then simply says nothing happened.
 */
export function isOnTarget(day: DayPoint, targetKcal: number): boolean {
  if (targetKcal <= 0) return false;
  return Math.abs(day.kcal - targetKcal) / targetKcal <= ON_TARGET_TOLERANCE;
}

/**
 * One nutrient's average against its target.
 *
 * `loggedDays` is passed rather than inferred from the average, because an
 * average of 0 is a real figure — a week of black coffee — and "no days logged"
 * is not. `week.averages` reports 0 for both, so the count is the only thing
 * that can tell them apart, and treating the first as the second would print a
 * dash where a true and slightly alarming number belongs.
 */
function averageOf(
  average: number,
  target: number,
  loggedDays: number,
  dp: number,
): WeekAverage {
  if (loggedDays === 0) {
    return { average: null, target: target > 0 ? target : null, deltaFromTarget: null, percentOfTarget: null };
  }

  const value = round(average, dp);
  // A goal of 0 is "not set". Dividing by it gives Infinity, and reporting 0%
  // would be a different lie — the same rule `factsFor` follows on a meal.
  if (target <= 0) {
    return { average: value, target: null, deltaFromTarget: null, percentOfTarget: null };
  }

  return {
    average: value,
    target,
    deltaFromTarget: round(value - target, dp),
    percentOfTarget: Math.round((value / target) * 100),
  };
}

/**
 * The logged day nearest to, or furthest from, the calorie target.
 *
 * Distance is absolute — a day 400 over and a day 400 under are equally far —
 * but `offByKcal` keeps its sign, because "your furthest day" with the
 * direction stripped off is exactly the sentence a model would guess at.
 *
 * Ties go to the earlier day, which is arbitrary and stable. What it must not
 * be is unstable: the same week rendering a different "worst day" on a second
 * request would make the review look made up even though every figure in it
 * was right.
 */
function pickDay(
  logged: DayPoint[],
  targetKcal: number,
  which: 'closest' | 'furthest',
): WeekDayMark | null {
  if (logged.length === 0 || targetKcal <= 0) return null;

  let best = logged[0]!;
  for (const day of logged.slice(1)) {
    const here = Math.abs(day.kcal - targetKcal);
    const there = Math.abs(best.kcal - targetKcal);
    if (which === 'closest' ? here < there : here > there) best = day;
  }

  return {
    date: best.date,
    kcal: round(best.kcal, 0),
    offByKcal: round(best.kcal - targetKcal, 0),
  };
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
