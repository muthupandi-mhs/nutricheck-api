import { schema } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { StepsService } from '../src/modules/steps/steps.service';
import { startTestPostgres, type TestDatabase } from './postgres';

/**
 * Steps history.
 *
 * Much smaller than `weight.int-spec.ts`: there is no profile column and no
 * goal on the other side of a write, so the only things worth asserting are
 * the upsert, the gap-fill, and the aggregates over the window.
 */
describe('steps', () => {
  let pg: TestDatabase;
  let steps: StepsService;

  beforeAll(async () => {
    pg = await startTestPostgres();
    steps = new StepsService(pg.db);
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

  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number): string =>
    new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);

  describe('recording', () => {
    it('corrects the day rather than recording it twice', async () => {
      const userId = await newUser('correct');
      await steps.log(userId, { steps: 6000 }, 30);
      const report = await steps.log(userId, { steps: 8123 }, 30);

      const point = report.days.find((d) => d.date === today);
      expect(point).toEqual({ date: today, steps: 8123, logged: true });
      expect(report.loggedDays).toBe(1);
    });

    it('returns the whole report, so the screen needs no second call', async () => {
      const userId = await newUser('returns');
      const report = await steps.log(userId, { steps: 5000, date: daysAgo(3) }, 7);

      expect(report.days).toHaveLength(7);
      expect(report.totalSteps).toBe(5000);
    });
  });

  describe('the gap fill', () => {
    it('fills days with no entry as unlogged zeros', async () => {
      const userId = await newUser('gaps');
      await steps.log(userId, { steps: 4000, date: daysAgo(2) }, 7);
      await steps.log(userId, { steps: 6000, date: today }, 7);

      const report = await steps.report(userId, 7);
      const middle = report.days.find((d) => d.date === daysAgo(1));

      expect(middle).toEqual({ date: daysAgo(1), steps: 0, logged: false });
      expect(report.loggedDays).toBe(2);
    });
  });

  describe('the aggregates', () => {
    it('sums and averages over logged days only', async () => {
      const userId = await newUser('averages');
      await steps.log(userId, { steps: 3000, date: daysAgo(2) }, 7);
      await steps.log(userId, { steps: 9000, date: daysAgo(1) }, 7);
      await steps.log(userId, { steps: 6000, date: today }, 7);

      const report = await steps.report(userId, 7);

      expect(report.totalSteps).toBe(18_000);
      expect(report.averageSteps).toBe(6000);
      expect(report.loggedDays).toBe(3);
      expect(report.bestDay).toEqual({ date: daysAgo(1), steps: 9000, logged: true });
    });

    it('reports zero average and a null best day when nothing was logged', async () => {
      const userId = await newUser('empty');
      const report = await steps.report(userId, 7);

      expect(report.totalSteps).toBe(0);
      expect(report.averageSteps).toBe(0);
      expect(report.loggedDays).toBe(0);
      expect(report.bestDay).toBeNull();
      expect(report.days.every((d) => !d.logged)).toBe(true);
    });
  });

  describe('deleting', () => {
    it('removes a reading, and the day reverts to a gap', async () => {
      const userId = await newUser('delete');
      await steps.log(userId, { steps: 7000 }, 7);

      const report = await steps.remove(userId, today, 7);

      const point = report.days.find((d) => d.date === today);
      expect(point).toEqual({ date: today, steps: 0, logged: false });
    });

    it('404s on a day that was never logged', async () => {
      const userId = await newUser('missing');

      await expect(steps.remove(userId, today, 7)).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });

    it('cannot delete a reading belonging to somebody else', async () => {
      const mine = await newUser('mine');
      const theirs = await newUser('theirs');
      await steps.log(mine, { steps: 5000, date: daysAgo(1) }, 7);

      await expect(steps.remove(theirs, daysAgo(1), 7)).rejects.toMatchObject({
        problem: { status: 404 },
      });

      const report = await steps.report(mine, 7);
      expect(report.days.find((d) => d.date === daysAgo(1))?.logged).toBe(true);
    });
  });
});
