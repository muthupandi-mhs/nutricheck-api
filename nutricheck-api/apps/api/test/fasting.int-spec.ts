import { FASTING_DEFAULT_TARGET_HOURS } from '@nutricheck/contracts';
import { and, eq, isNull, schema } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { FastingService } from '../src/modules/fasting/fasting.service';
import { startTestPostgres, type TestDatabase } from './postgres';

const HOUR = 3_600_000;

/**
 * Declared fasts.
 *
 * Two things are under test here more than any others, because they are the
 * two that would be silently wrong:
 *
 *   1. **One open fast per user.** Enforced by a partial unique index, not by
 *      the service's check — so the tests go around the service to prove the
 *      database refuses it.
 *   2. **The arithmetic on the wire.** `hours` is null while a fast runs and a
 *      real number afterwards, and `reachedTarget` is decided on the rounded
 *      figure the client prints rather than the raw one. Getting the second
 *      wrong puts "16h" and "missed" on the same row.
 */
describe('fasting', () => {
  let pg: TestDatabase;
  let fasting: FastingService;

  beforeAll(async () => {
    pg = await startTestPostgres();
    fasting = new FastingService(pg.db);
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

  const agoIso = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

  /**
   * A finished fast written straight to the table.
   *
   * The service deliberately refuses to backdate past 72 hours, which is right
   * for a user and useless for a test that needs a history. Writing rows
   * directly is how the record and the ordering get exercised without
   * pretending the API can produce them.
   */
  async function seedFinished(
    userId: string,
    startedHoursAgo: number,
    ranHours: number,
    targetHours: number,
  ): Promise<void> {
    const startedAt = new Date(Date.now() - startedHoursAgo * HOUR);
    await pg.db.insert(schema.fastingSessions).values({
      userId,
      startedAt,
      endedAt: new Date(startedAt.getTime() + ranHours * HOUR),
      targetHours,
    });
  }

  describe('one open fast, and only one', () => {
    it('starts one, and reports it as running with no length yet', async () => {
      const userId = await newUser('start');
      const summary = await fasting.start(userId, { targetHours: 16 }, 30);

      expect(summary.current).not.toBeNull();
      expect(summary.current!.targetHours).toBe(16);
      expect(summary.current!.endedAt).toBeNull();
      // The whole point of the contract: a running fast has no length on the
      // wire, because the number would be stale before it arrived and the
      // device has a clock that is right continuously.
      expect(summary.current!.hours).toBeNull();
      expect(summary.current!.reachedTarget).toBeNull();
      expect(summary.recent).toHaveLength(0);
      expect(summary.stats).toBeNull();
    });

    it('refuses a second one with a 409, not a 500', async () => {
      const userId = await newUser('twice');
      await fasting.start(userId, { targetHours: 16 }, 30);

      await expect(fasting.start(userId, { targetHours: 18 }, 30)).rejects.toMatchObject({
        problem: { status: 409 },
      });
    });

    it('refuses a second one at the database, not merely in the service', async () => {
      // The service's check can lose a race — two taps a few milliseconds
      // apart both find nothing open. This is the guarantee that survives it.
      const userId = await newUser('race');
      await fasting.start(userId, { targetHours: 16 }, 30);

      await expect(
        pg.db
          .insert(schema.fastingSessions)
          .values({ userId, startedAt: new Date(), targetHours: 18 }),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('lets a second user fast at the same time', async () => {
      // The index is on (user_id) WHERE ended_at IS NULL. If it were global,
      // one person fasting would block everybody.
      const a = await newUser('conc-a');
      const b = await newUser('conc-b');
      await fasting.start(a, { targetHours: 16 }, 30);
      const other = await fasting.start(b, { targetHours: 20 }, 30);

      expect(other.current!.targetHours).toBe(20);
    });

    it('lets a new fast start once the last one has ended', async () => {
      const userId = await newUser('again');
      await fasting.start(userId, { targetHours: 16, startedAt: agoIso(17) }, 30);
      await fasting.end(userId, {}, 30);

      const summary = await fasting.start(userId, { targetHours: 18 }, 30);
      expect(summary.current!.targetHours).toBe(18);
      expect(summary.recent).toHaveLength(1);
    });
  });

  describe('the start time', () => {
    it('backdates, because nobody remembers to press start on time', async () => {
      const userId = await newUser('backdate');
      const startedAt = agoIso(3);
      const summary = await fasting.start(userId, { targetHours: 16, startedAt }, 30);

      expect(summary.current!.startedAt).toBe(new Date(startedAt).toISOString());
    });

    it('refuses a start in the future', async () => {
      const userId = await newUser('future');
      const ahead = new Date(Date.now() + 6 * HOUR).toISOString();

      await expect(
        fasting.start(userId, { targetHours: 16, startedAt: ahead }, 30),
      ).rejects.toMatchObject({ problem: { status: 422 } });
    });

    it('refuses a start further back than the backdate window', async () => {
      // Past three days it is not a correction, it is a fast being invented
      // after the fact — and the history is only worth keeping if it holds
      // fasts somebody actually sat through.
      const userId = await newUser('ancient');

      await expect(
        fasting.start(userId, { targetHours: 16, startedAt: agoIso(80) }, 30),
      ).rejects.toMatchObject({ problem: { status: 422 } });
    });

    it('tolerates a phone whose clock is a few seconds fast', async () => {
      const userId = await newUser('skew');
      const slightlyAhead = new Date(Date.now() + 20_000).toISOString();

      const summary = await fasting.start(
        userId,
        { targetHours: 16, startedAt: slightlyAhead },
        30,
      );
      expect(summary.current).not.toBeNull();
    });
  });

  describe('ending one', () => {
    it('records the length and whether it made the target', async () => {
      const userId = await newUser('end');
      await fasting.start(userId, { targetHours: 16, startedAt: agoIso(17) }, 30);
      const summary = await fasting.end(userId, {}, 30);

      expect(summary.current).toBeNull();
      expect(summary.recent).toHaveLength(1);
      expect(summary.recent[0]!.hours).toBeCloseTo(17, 1);
      expect(summary.recent[0]!.reachedTarget).toBe(true);
    });

    it('says so when the target was missed', async () => {
      const userId = await newUser('short');
      await fasting.start(userId, { targetHours: 18, startedAt: agoIso(12) }, 30);
      const summary = await fasting.end(userId, {}, 30);

      expect(summary.recent[0]!.reachedTarget).toBe(false);
    });

    it('counts a fast that rounds up to its target as reaching it', async () => {
      // 15.9994 h prints as "16h" on the client. A raw `>= 16` would call that
      // a miss and put two contradictory facts on one row.
      const userId = await newUser('rounding');
      const startedAt = new Date(Date.now() - (16 * HOUR - 2_000));
      await pg.db
        .insert(schema.fastingSessions)
        .values({ userId, startedAt, targetHours: 16 });

      const summary = await fasting.end(userId, {}, 30);

      expect(summary.recent[0]!.hours).toBe(16);
      expect(summary.recent[0]!.reachedTarget).toBe(true);
    });

    it('accepts an end time in the past, because the first bite precedes the phone', async () => {
      const userId = await newUser('endback');
      await fasting.start(userId, { targetHours: 16, startedAt: agoIso(20) }, 30);
      const endedAt = agoIso(2);

      const summary = await fasting.end(userId, { endedAt }, 30);
      expect(summary.recent[0]!.hours).toBeCloseTo(18, 1);
    });

    it('refuses an end before the start', async () => {
      const userId = await newUser('negative');
      await fasting.start(userId, { targetHours: 16, startedAt: agoIso(2) }, 30);

      await expect(
        fasting.end(userId, { endedAt: agoIso(5) }, 30),
      ).rejects.toMatchObject({ problem: { status: 422 } });
    });

    it('refuses a negative span at the database too', async () => {
      const userId = await newUser('ck');
      const startedAt = new Date();

      await expect(
        pg.db.insert(schema.fastingSessions).values({
          userId,
          startedAt,
          endedAt: new Date(startedAt.getTime() - HOUR),
          targetHours: 16,
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('404s when nothing is running', async () => {
      const userId = await newUser('nothing');
      await expect(fasting.end(userId, {}, 30)).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });

    it('is safe to send twice — the second attempt does not overwrite the first', async () => {
      const userId = await newUser('double');
      await fasting.start(userId, { targetHours: 16, startedAt: agoIso(17) }, 30);
      const first = await fasting.end(userId, {}, 30);

      await expect(fasting.end(userId, {}, 30)).rejects.toMatchObject({
        problem: { status: 404 },
      });

      const after = await fasting.summary(userId, 30);
      expect(after.recent[0]!.endedAt).toBe(first.recent[0]!.endedAt);
    });

    it('leaves a fast running for days running, rather than closing it', async () => {
      // No cron closes one at its target and none is auto-closed. Anything
      // else is the server inventing the moment somebody stopped fasting.
      const userId = await newUser('forgotten');
      await pg.db.insert(schema.fastingSessions).values({
        userId,
        startedAt: new Date(Date.now() - 120 * HOUR),
        targetHours: 16,
      });

      const summary = await fasting.summary(userId, 30);
      expect(summary.current).not.toBeNull();
      expect(summary.current!.endedAt).toBeNull();
    });
  });

  describe('adjusting the running fast', () => {
    it('extends the target without touching the time already served', async () => {
      // The alternative — end and restart — throws away the hours already
      // done, which is the one thing the screen exists to hold onto.
      const userId = await newUser('extend');
      const started = await fasting.start(userId, { targetHours: 16, startedAt: agoIso(14) }, 30);

      const summary = await fasting.adjust(userId, { targetHours: 18 }, 30);

      expect(summary.current!.targetHours).toBe(18);
      expect(summary.current!.startedAt).toBe(started.current!.startedAt);
      expect(summary.current!.id).toBe(started.current!.id);
    });

    it('corrects the start time', async () => {
      const userId = await newUser('restart');
      await fasting.start(userId, { targetHours: 16 }, 30);
      const startedAt = agoIso(4);

      const summary = await fasting.adjust(userId, { startedAt }, 30);
      expect(summary.current!.startedAt).toBe(new Date(startedAt).toISOString());
      expect(summary.current!.targetHours).toBe(16);
    });

    it('refuses an empty body with a field to point at', async () => {
      const userId = await newUser('empty');
      await fasting.start(userId, { targetHours: 16 }, 30);

      await expect(fasting.adjust(userId, {}, 30)).rejects.toMatchObject({
        problem: { status: 422 },
      });
    });

    it('404s when nothing is running', async () => {
      const userId = await newUser('adjust-none');
      await expect(fasting.adjust(userId, { targetHours: 18 }, 30)).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });
  });

  describe('discarding', () => {
    it('throws away the running one, leaving nothing behind', async () => {
      const userId = await newUser('cancel');
      const started = await fasting.start(userId, { targetHours: 16 }, 30);

      const summary = await fasting.remove(userId, started.current!.id, 30);

      expect(summary.current).toBeNull();
      expect(summary.recent).toHaveLength(0);
    });

    it('removes a finished one from the history', async () => {
      const userId = await newUser('forget');
      await seedFinished(userId, 40, 16, 16);
      const before = await fasting.summary(userId, 30);

      const summary = await fasting.remove(userId, before.recent[0]!.id, 30);

      expect(summary.recent).toHaveLength(0);
      // Nothing is derived from a fast, so an empty history is an ordinary
      // state — there is no "you cannot delete your last one" rule here.
      expect(summary.stats).toBeNull();
    });

    it('will not delete another account’s fast', async () => {
      const mine = await newUser('mine');
      const theirs = await newUser('theirs');
      const started = await fasting.start(theirs, { targetHours: 16 }, 30);

      await expect(fasting.remove(mine, started.current!.id, 30)).rejects.toMatchObject({
        problem: { status: 404 },
      });

      const untouched = await fasting.summary(theirs, 30);
      expect(untouched.current).not.toBeNull();
    });
  });

  describe('the record', () => {
    it('is all-time, not merely over the window the list shows', async () => {
      // A "longest fast" that quietly forgets March is a worse number than no
      // number, so the stats query ignores `limit` entirely.
      const userId = await newUser('alltime');
      await seedFinished(userId, 1000, 22, 16); // the longest, far outside any window
      await seedFinished(userId, 40, 16, 16);
      await seedFinished(userId, 20, 10, 16);

      const summary = await fasting.summary(userId, 1);

      expect(summary.recent).toHaveLength(1);
      expect(summary.stats).toEqual({
        completed: 3,
        reached: 2,
        longestHours: 22,
        averageHours: 16,
      });
    });

    it('does not count the fast that is still running', async () => {
      const userId = await newUser('openstats');
      await seedFinished(userId, 40, 16, 16);
      await fasting.start(userId, { targetHours: 20 }, 30);

      const summary = await fasting.summary(userId, 30);
      expect(summary.stats!.completed).toBe(1);
    });

    it('is null before anything has finished', async () => {
      const userId = await newUser('nostats');
      await fasting.start(userId, { targetHours: 16 }, 30);

      // "Your average fast is 0h" is a claim about somebody who has never
      // finished one, and it is not true of them.
      expect((await fasting.summary(userId, 30)).stats).toBeNull();
    });
  });

  describe('the history', () => {
    it('is newest first and bounded by the limit', async () => {
      const userId = await newUser('order');
      await seedFinished(userId, 100, 16, 16);
      await seedFinished(userId, 60, 17, 16);
      await seedFinished(userId, 20, 18, 16);

      const summary = await fasting.summary(userId, 2);

      expect(summary.recent.map(f => f.hours)).toEqual([18, 17]);
    });

    it('holds two fasts that began and ended on the same calendar day', async () => {
      // A fast is an interval on the clock, not a measurement of a day — which
      // is the whole reason this table is keyed by instants rather than by
      // date the way weight_logs is.
      const userId = await newUser('sameday');
      await seedFinished(userId, 20, 5, 4);
      await seedFinished(userId, 12, 5, 4);

      expect((await fasting.summary(userId, 30)).recent).toHaveLength(2);
    });
  });

  describe('the plan the start control opens on', () => {
    it('is the default for somebody who has never fasted', async () => {
      const userId = await newUser('plan-new');
      const summary = await fasting.summary(userId, 30);

      expect(summary.lastTargetHours).toBe(FASTING_DEFAULT_TARGET_HOURS);
    });

    it('is the last one finished', async () => {
      const userId = await newUser('plan-last');
      await seedFinished(userId, 100, 16, 16);
      await seedFinished(userId, 20, 19, 20);

      expect((await fasting.summary(userId, 30)).lastTargetHours).toBe(20);
    });

    it('is what is running, when something is', async () => {
      const userId = await newUser('plan-open');
      await seedFinished(userId, 100, 16, 16);
      await fasting.start(userId, { targetHours: 23 }, 30);

      expect((await fasting.summary(userId, 30)).lastTargetHours).toBe(23);
    });

    it('follows an extension made mid-fast', async () => {
      const userId = await newUser('plan-extend');
      await fasting.start(userId, { targetHours: 16 }, 30);
      await fasting.adjust(userId, { targetHours: 18 }, 30);

      expect((await fasting.summary(userId, 30)).lastTargetHours).toBe(18);
    });
  });

  describe('deleting the account', () => {
    it('takes the fasts with it', async () => {
      const userId = await newUser('cascade');
      await fasting.start(userId, { targetHours: 16 }, 30);

      await pg.db.delete(schema.users).where(eq(schema.users.id, userId));

      const rows = await pg.db
        .select({ id: schema.fastingSessions.id })
        .from(schema.fastingSessions)
        .where(
          and(
            eq(schema.fastingSessions.userId, userId),
            isNull(schema.fastingSessions.endedAt),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });
});
