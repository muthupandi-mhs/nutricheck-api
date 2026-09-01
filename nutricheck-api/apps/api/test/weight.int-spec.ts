import type { UserProfile } from '@nutricheck/contracts';
import { eq, schema } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { GoalsService } from '../src/modules/goals/goals.service';
import { WeightService } from '../src/modules/weight/weight.service';
import { startTestPostgres, type TestDatabase } from './postgres';

const PROFILE: UserProfile = {
  sex: 'male',
  birthDate: '1991-01-01',
  heightCm: 180,
  weightKg: 80,
  activityLevel: 'moderate',
  objective: 'lose',
  rateKgPerWeek: 0.5,
  units: 'metric',
};

/**
 * Weight history.
 *
 * The subject of nearly every test here is the seam: `user_profiles.weight_kg`
 * is the current weight and `weight_logs` is the history, and the two are
 * written by different code paths. Anything that lets them disagree shows the
 * user one weight on the Home dial and a different one on the chart, which is
 * the specific failure this table was added to make impossible.
 */
describe('weight', () => {
  let pg: TestDatabase;
  let goals: GoalsService;
  let weight: WeightService;

  beforeAll(async () => {
    pg = await startTestPostgres();
    goals = new GoalsService(pg.db);
    weight = new WeightService(pg.db, goals);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function newUser(tag: string): Promise<string> {
    const [user] = await pg.db
      .insert(schema.users)
      .values({ email: `${tag}-${randomUUID()}@example.com` })
      .returning({ id: schema.users.id });
    return user!.id;
  }

  /** A user with a saved profile — the state anyone reaching this screen is in. */
  async function onboarded(tag: string): Promise<string> {
    const userId = await newUser(tag);
    await goals.upsertProfile(userId, PROFILE);
    return userId;
  }

  async function profileWeight(userId: string): Promise<number> {
    const [row] = await pg.db
      .select({ weightKg: schema.userProfiles.weightKg })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));
    return row!.weightKg;
  }

  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number): string =>
    new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);

  describe('the profile and the history', () => {
    it('seeds the history from the profile save, so the chart is never empty', async () => {
      // Onboarding asks for a weight and never asks again. If that answer does
      // not land here, a user's first look at this screen says they have never
      // weighed themselves — while the dial beside it shows 80 kg.
      const userId = await onboarded('seed');
      const series = await weight.series(userId, 90);

      expect(series.points).toHaveLength(1);
      expect(series.points[0]!.weightKg).toBe(80);
      expect(series.current).toEqual({ date: today, weightKg: 80 });
      expect(series.start).toEqual({ date: today, weightKg: 80 });
    });

    it('moves the profile weight when the newest reading changes', async () => {
      const userId = await onboarded('newest');
      await weight.log(userId, { weightKg: 78.4 }, 90);

      expect(await profileWeight(userId)).toBe(78.4);
    });

    it('recomputes the goal from the new weight', async () => {
      // The reason the two are coupled at all: Mifflin–St Jeor takes a weight,
      // so a weight that changes without the targets changing leaves somebody
      // eating to a number derived from a body they no longer have.
      const userId = await onboarded('goal');
      const before = await goals.currentGoal(userId);

      await weight.log(userId, { weightKg: 70 }, 90);
      const after = await goals.currentGoal(userId);

      expect(after.kcal).toBeLessThan(before.kcal);
      expect(after.basis.bmr).toBeLessThan(before.basis.bmr);
    });

    it('leaves the profile alone when an OLDER reading is backfilled', async () => {
      // Entering Saturday's weigh-in on Monday must not tell the app that
      // Saturday's figure is what you weigh now.
      const userId = await onboarded('backfill');
      await weight.log(userId, { weightKg: 78 }, 90);
      await weight.log(userId, { weightKg: 83, date: daysAgo(10) }, 90);

      expect(await profileWeight(userId)).toBe(78);
      const series = await weight.series(userId, 90);
      expect(series.current).toEqual({ date: today, weightKg: 78 });
      expect(series.start).toEqual({ date: daysAgo(10), weightKg: 83 });
    });

    it('carries a profile weight change into the history', async () => {
      // The other door. Editing the weight on the profile screen has to show up
      // on the chart, or the chart is flat through a change the user made.
      const userId = await onboarded('profile-edit');
      await goals.upsertProfile(userId, { weightKg: 76.5 });

      const series = await weight.series(userId, 90);
      expect(series.current).toEqual({ date: today, weightKg: 76.5 });
    });
  });

  describe('recording', () => {
    it('corrects the day rather than recording it twice', async () => {
      // A weight is a measurement OF a day. Stepping on the scale again an hour
      // later is a correction, and the unique index makes a replayed request
      // harmless rather than an error.
      const userId = await onboarded('correct');
      await weight.log(userId, { weightKg: 79 }, 90);
      const series = await weight.log(userId, { weightKg: 79.6 }, 90);

      expect(series.points).toHaveLength(1);
      expect(series.points[0]!.weightKg).toBe(79.6);
      expect(await profileWeight(userId)).toBe(79.6);
    });

    it('returns the whole series, so the screen needs no second call', async () => {
      const userId = await onboarded('returns');
      const series = await weight.log(userId, { weightKg: 77, date: daysAgo(3) }, 90);

      expect(series.points.map((p) => p.date)).toEqual([daysAgo(3), today]);
    });
  });

  describe('deleting', () => {
    it('refuses to delete the only reading there is', async () => {
      // The profile's weight is NOT NULL and every goal is derived from it, so
      // there is no such thing as an account with no weight. Allowing this
      // would leave the profile holding a figure with no record behind it.
      const userId = await onboarded('only');

      await expect(weight.remove(userId, today, 90)).rejects.toMatchObject({
        problem: { status: 409 },
      });

      const series = await weight.series(userId, 90);
      expect(series.points).toHaveLength(1);
      expect(await profileWeight(userId)).toBe(80);
    });

    it('promotes the reading before it when the newest is deleted', async () => {
      // The profile follows the newest reading on the way in, so it has to
      // follow it on the way out — otherwise deleting today leaves the app
      // insisting you still weigh what today said.
      const userId = await onboarded('promote');
      await weight.log(userId, { weightKg: 78, date: daysAgo(7) }, 90);
      await weight.log(userId, { weightKg: 77, date: today }, 90);
      expect(await profileWeight(userId)).toBe(77);

      const series = await weight.remove(userId, today, 90);

      expect(series.current).toEqual({ date: daysAgo(7), weightKg: 78 });
      expect(await profileWeight(userId)).toBe(78);
    });

    it('recomputes the targets from the promoted reading', async () => {
      const userId = await onboarded('promote-goal');
      await weight.log(userId, { weightKg: 95, date: daysAgo(7) }, 90);
      await weight.log(userId, { weightKg: 60, date: today }, 90);
      const atSixty = await goals.currentGoal(userId);

      await weight.remove(userId, today, 90);
      const atNinetyFive = await goals.currentGoal(userId);

      expect(atNinetyFive.kcal).toBeGreaterThan(atSixty.kcal);
    });

    it('leaves the profile alone when an older reading is deleted', async () => {
      const userId = await onboarded('delete-old');
      await weight.log(userId, { weightKg: 83, date: daysAgo(20) }, 90);
      await weight.log(userId, { weightKg: 78, date: today }, 90);

      const series = await weight.remove(userId, daysAgo(20), 90);

      expect(await profileWeight(userId)).toBe(78);
      expect(series.points.map(p => p.date)).not.toContain(daysAgo(20));
      expect(series.current).toEqual({ date: today, weightKg: 78 });
    });

    it('404s on a day that was never logged', async () => {
      const userId = await onboarded('missing');
      await weight.log(userId, { weightKg: 78 }, 90);

      await expect(weight.remove(userId, daysAgo(3), 90)).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });

    it('cannot delete a reading belonging to somebody else', async () => {
      // The day is the whole address, so a delete that did not scope by user
      // would remove somebody else's Tuesday.
      const mine = await onboarded('mine');
      const theirs = await onboarded('theirs');
      await weight.log(mine, { weightKg: 78, date: daysAgo(2) }, 90);

      await expect(weight.remove(theirs, daysAgo(2), 90)).rejects.toMatchObject({
        problem: { status: 404 },
      });

      const series = await weight.series(mine, 90);
      expect(series.points.map(p => p.date)).toContain(daysAgo(2));
    });
  });

  describe('the trend', () => {
    it('is null with one reading, because one point is not a line', async () => {
      const userId = await onboarded('one-point');
      const series = await weight.series(userId, 90);

      expect(series.points).toHaveLength(1);
      expect(series.trend).toBeNull();
    });

    it('fits a slope in kg per week', async () => {
      const userId = await newUser('slope');
      // 1 kg down per fortnight, exactly, with no profile in the way.
      for (const [n, kg] of [
        [28, 82],
        [21, 81.5],
        [14, 81],
        [7, 80.5],
        [0, 80],
      ] as const) {
        await pg.db
          .insert(schema.weightLogs)
          .values({ userId, measuredOn: daysAgo(n), weightKg: kg });
      }

      const series = await weight.series(userId, 90);
      expect(series.trend).not.toBeNull();
      expect(series.trend!.kgPerWeek).toBeCloseTo(-0.5, 5);
      expect(series.trend!.deltaKg).toBeCloseTo(-2, 5);
      expect(series.trend!.spanDays).toBe(28);
    });

    it('is not swung by one bad morning the way two endpoints would be', async () => {
      // The whole reason for a least-squares fit. Sixteen readings say "flat";
      // the last one is a dehydrated Tuesday. `deltaKg` reports the endpoints
      // honestly, and the fitted slope refuses to call that a trend.
      const userId = await newUser('noise');
      for (let n = 30; n >= 2; n -= 2) {
        await pg.db
          .insert(schema.weightLogs)
          .values({ userId, measuredOn: daysAgo(n), weightKg: 80 });
      }
      await pg.db
        .insert(schema.weightLogs)
        .values({ userId, measuredOn: daysAgo(0), weightKg: 78 });

      const series = await weight.series(userId, 90);
      expect(series.trend!.deltaKg).toBeCloseTo(-2, 5);
      // An endpoints-only reading would call this -0.47 kg/week.
      expect(Math.abs(series.trend!.kgPerWeek)).toBeLessThan(0.2);
    });

    it('carries the intended rate as a signed figure, so intent sits beside outcome', async () => {
      const userId = await onboarded('intent');
      await weight.log(userId, { weightKg: 79, date: daysAgo(7) }, 90);

      const series = await weight.series(userId, 90);
      // 'lose' at 0.5 kg/week is NEGATIVE here. A client reconstructing the
      // sign from `objective` is a second place to get it backwards.
      expect(series.trend!.intendedKgPerWeek).toBe(-0.5);
    });

    it('has no intended rate for somebody maintaining', async () => {
      const userId = await newUser('maintain');
      await goals.upsertProfile(userId, { ...PROFILE, objective: 'maintain', rateKgPerWeek: 0 });
      await weight.log(userId, { weightKg: 79, date: daysAgo(7) }, 90);

      const series = await weight.series(userId, 90);
      // Null, not 0: "no intended rate" and "an intended rate of zero" read the
      // same as a number and differently on a screen.
      expect(series.trend!.intendedKgPerWeek).toBeNull();
    });
  });

  describe('the window', () => {
    it('charts the window but still reports the weight from outside it', async () => {
      // Somebody who has not weighed themselves in four months has a weight.
      // Showing them a dash because it fell off the left of the chart would be
      // the screen forgetting something it knows.
      const userId = await newUser('window');
      await pg.db
        .insert(schema.weightLogs)
        .values({ userId, measuredOn: daysAgo(200), weightKg: 84 });

      const series = await weight.series(userId, 90);
      expect(series.points).toHaveLength(0);
      expect(series.current).toEqual({ date: daysAgo(200), weightKg: 84 });
      expect(series.start).toEqual({ date: daysAgo(200), weightKg: 84 });
      expect(series.trend).toBeNull();
    });
  });
});
