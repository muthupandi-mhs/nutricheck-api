import type { CommitLogEntry, UserProfile } from '@nutricheck/contracts';
import { eq, schema } from '@nutricheck/database';
import { ingestUsda } from '@nutricheck/ingest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GoalsService } from '../src/modules/goals/goals.service';
import { LogsService } from '../src/modules/logs/logs.service';
import { startTestPostgres, type TestDatabase } from './postgres';

const FIXTURES = join(__dirname, '..', '..', '..', 'tools', 'ingest', 'fixtures');

const PROFILE: UserProfile = {
  sex: 'male',
  birthDate: '1991-01-01',
  heightCm: 180,
  weightKg: 80,
  activityLevel: 'moderate',
  objective: 'maintain',
  rateKgPerWeek: 0,
  units: 'metric',
};

describe('log commit', () => {
  let pg: TestDatabase;
  let goals: GoalsService;
  let logs: LogsService;
  let userId: string;
  /** Lentils: 116 kcal, 9.02 g protein, 7.9 g fiber per 100 g. */
  let lentilsId: string;
  /** Chicken breast: fiber is genuinely unmeasured. */
  let chickenId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    goals = new GoalsService(pg.db);
    logs = new LogsService(pg.db, goals);

    await ingestUsda(pg.db, FIXTURES);

    const [user] = await pg.db
      .insert(schema.users)
      .values({ email: 'logs-int@example.com' })
      .returning({ id: schema.users.id });
    userId = user!.id;

    lentilsId = await foodIdBySourceId('169705');
    chickenId = await foodIdBySourceId('747447');
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function foodIdBySourceId(sourceId: string): Promise<string> {
    const [row] = await pg.db
      .select({ id: schema.foods.id })
      .from(schema.foods)
      .where(eq(schema.foods.sourceId, sourceId));
    return row!.id;
  }

  function entry(overrides: Partial<CommitLogEntry> = {}): CommitLogEntry {
    return {
      clientId: randomUUID(),
      loggedAt: '2026-08-26T12:30:00.000Z',
      meal: 'lunch',
      source: 'search',
      phrase: null,
      draftId: null,
      items: [
        {
          foodId: lentilsId,
          grams: 198,
          quantityType: 'standard_measure',
          quantitySource: 'food_portion',
          learnedUnitLabel: null,
        },
      ],
      ...overrides,
    };
  }

  describe('server-side arithmetic', () => {
    it('computes nutrients from the corpus, not from the request', async () => {
      // 116 kcal/100g x 198 g = 229.68. The client sends grams only.
      const { entry: saved, created } = await logs.commit(userId, entry());
      expect(created).toBe(true);
      // Carbs and fat are unmeasured on this fixture row, so they come back
      // unknown rather than zero — the same three-state rule fiber has always
      // followed. Asserting the whole object is deliberate: it is what stops a
      // new nutrient from being silently dropped on the way to the client.
      expect(saved.items[0]?.nutrients).toEqual({
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

    it('carries unmeasured fiber through as unknown, not zero', async () => {
      const { entry: saved } = await logs.commit(
        userId,
        entry({
          items: [
            {
              foodId: chickenId,
              grams: 180,
              quantityType: 'exact_mass',
              quantitySource: 'stated',
              learnedUnitLabel: null,
            },
          ],
        }),
      );

      expect(saved.items[0]?.nutrients.fiberG).toBeNull();
      expect(saved.items[0]?.nutrients.fiberState).toBe('unknown');
    });

    it('freezes nutrients — a corpus correction does not rewrite history', async () => {
      // The whole reason log_items stores copies rather than joining. USDA
      // reissues data and you will re-ingest; a Tuesday in March must not move.
      const { entry: saved } = await logs.commit(userId, entry());
      const before = saved.items[0]!.nutrients.kcal;

      await pg.db
        .update(schema.foodNutrients)
        .set({ kcal: 999 })
        .where(eq(schema.foodNutrients.foodId, lentilsId));

      const reread = await logs.getById(userId, saved.id);
      expect(reread.items[0]?.nutrients.kcal).toBe(before);

      await pg.db
        .update(schema.foodNutrients)
        .set({ kcal: 116 })
        .where(eq(schema.foodNutrients.foodId, lentilsId));
    });
  });

  describe('idempotency', () => {
    it('returns the original entry when the same clientId is replayed', async () => {
      const input = entry();
      const first = await logs.commit(userId, input);
      const replay = await logs.commit(userId, input);

      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.entry.id).toBe(first.entry.id);
    });

    it('does not create a second entry on replay', async () => {
      const input = entry();
      await logs.commit(userId, input);
      await logs.commit(userId, input);

      const rows = await pg.db
        .select({ id: schema.logEntries.id })
        .from(schema.logEntries)
        .where(eq(schema.logEntries.clientId, input.clientId));
      expect(rows).toHaveLength(1);
    });

    it('survives concurrent replays of the same clientId', async () => {
      // The SELECT-then-INSERT check has a race window; the unique index is the
      // real arbiter. Ten simultaneous drains must still yield one breakfast.
      const input = entry();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => logs.commit(userId, input)),
      );

      const ids = new Set(results.map((r) => r.entry.id));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    });

    it('scopes the clientId to the user', async () => {
      // Two devices can generate the same UUID only pathologically, but the
      // index is (user_id, client_id) and that must be what enforces it.
      const [other] = await pg.db
        .insert(schema.users)
        .values({ email: `logs-other-${randomUUID()}@example.com` })
        .returning({ id: schema.users.id });

      const input = entry();
      const mine = await logs.commit(userId, input);
      const theirs = await logs.commit(other!.id, input);

      expect(theirs.created).toBe(true);
      expect(theirs.entry.id).not.toBe(mine.entry.id);
    });
  });

  describe('batch drain', () => {
    it('reports per element and does not fail the batch on one bad entry', async () => {
      const good = entry();
      const bad = entry({
        items: [
          {
            foodId: '00000000-0000-4000-8000-000000000000',
            grams: 100,
            quantityType: 'exact_mass',
            quantitySource: 'stated',
            learnedUnitLabel: null,
          },
        ],
      });
      const alsoGood = entry();

      const results = await logs.commitBatch(userId, [good, bad, alsoGood]);

      expect(results.map((r) => r.status)).toEqual(['created', 'failed', 'created']);
    });

    it('marks an already-committed entry as a duplicate rather than an error', async () => {
      const input = entry();
      await logs.commit(userId, input);

      const [result] = await logs.commitBatch(userId, [input]);
      expect(result?.status).toBe('duplicate');
    });
  });

  describe('learned portions', () => {
    it('writes a personal unit in the same transaction as the commit', async () => {
      // As a separate request this is the write that gets lost, and it is the
      // one that makes vague units resolvable next time.
      await logs.commit(
        userId,
        entry({
          items: [
            {
              foodId: lentilsId,
              grams: 210,
              quantityType: 'personal_unit',
              quantitySource: 'user_portion',
              learnedUnitLabel: 'Bowl',
            },
          ],
        }),
      );

      const [portion] = await pg.db
        .select()
        .from(schema.userPortions)
        .where(eq(schema.userPortions.userId, userId));

      expect(portion?.unitLabel).toBe('bowl');
      expect(portion?.grams).toBe(210);
    });

    it('counts corrections so confidence can grow with use', async () => {
      await logs.commit(
        userId,
        entry({
          items: [
            {
              foodId: lentilsId,
              grams: 225,
              quantityType: 'personal_unit',
              quantitySource: 'user_portion',
              learnedUnitLabel: 'bowl',
            },
          ],
        }),
      );

      const [portion] = await pg.db
        .select()
        .from(schema.userPortions)
        .where(eq(schema.userPortions.userId, userId));

      expect(portion?.grams).toBe(225);
      expect(portion?.nCorrections).toBeGreaterThan(1);
    });
  });

  describe('day view', () => {
    let dayUserId: string;
    let dayLogs: LogsService;

    beforeAll(async () => {
      const [user] = await pg.db
        .insert(schema.users)
        .values({ email: `day-${randomUUID()}@example.com` })
        .returning({ id: schema.users.id });
      dayUserId = user!.id;
      dayLogs = new LogsService(pg.db, goals);

      await goals.upsertProfile(dayUserId, PROFILE);
    });

    it('totals the day and excludes unmeasured fiber from the sum', async () => {
      await dayLogs.commit(dayUserId, {
        ...entry(),
        items: [
          {
            foodId: lentilsId,
            grams: 100,
            quantityType: 'exact_mass',
            quantitySource: 'stated',
            learnedUnitLabel: null,
          },
          {
            foodId: chickenId,
            grams: 100,
            quantityType: 'exact_mass',
            quantitySource: 'stated',
            learnedUnitLabel: null,
          },
        ],
      });

      const day = await dayLogs.day(dayUserId, '2026-08-26', 'UTC');

      expect(day.totals.kcal).toBe(236);
      expect(day.totals.fiberG).toBe(7.9);
      // The ring can say "7.9 g of 38 g, 1 item unmeasured" instead of lying.
      expect(day.totals.fiberUnmeasuredItems).toBe(1);
    });

    it('reports the goal in effect, not zero', async () => {
      const day = await dayLogs.day(dayUserId, '2026-08-26', 'UTC');
      expect(day.goal.kcal).toBeGreaterThan(0);
      expect(day.goal.fiberG).toBeGreaterThan(0);
    });

    it('resolves the goal that applied on that date, not the current one', async () => {
      // Otherwise a weight change retroactively turns last month's "you hit your
      // target" into a miss.
      const dayBefore = await dayLogs.day(dayUserId, '2026-08-26', 'UTC');
      const originalKcal = dayBefore.goal.kcal;

      await goals.override(dayUserId, { kcal: 1500, effectiveFrom: '2026-09-01' });

      const stillOriginal = await dayLogs.day(dayUserId, '2026-08-26', 'UTC');
      expect(stillOriginal.goal.kcal).toBe(originalKcal);

      const later = await dayLogs.day(dayUserId, '2026-09-05', 'UTC');
      expect(later.goal.kcal).toBe(1500);
    });

    it('uses the user timezone for the day boundary', async () => {
      // 23:30 in Asia/Kolkata is 18:00 UTC the same day; 01:00 UTC the next day
      // is still the previous evening there. UTC bucketing gets this wrong.
      const [user] = await pg.db
        .insert(schema.users)
        .values({ email: `tz-${randomUUID()}@example.com` })
        .returning({ id: schema.users.id });

      await dayLogs.commit(user!.id, {
        ...entry(),
        loggedAt: '2026-08-26T19:30:00.000Z', // 01:00 on the 27th in Kolkata
      });

      const utcDay = await dayLogs.day(user!.id, '2026-08-26', 'UTC');
      const kolkataDay = await dayLogs.day(user!.id, '2026-08-27', 'Asia/Kolkata');

      expect(utcDay.entries).toHaveLength(1);
      expect(kolkataDay.entries).toHaveLength(1);
    });

    it('returns an empty day rather than failing', async () => {
      const day = await dayLogs.day(dayUserId, '2020-01-01', 'UTC');
      expect(day.entries).toEqual([]);
      expect(day.totals.kcal).toBe(0);
    });
  });

  describe('ownership', () => {
    it('will not return another user entry', async () => {
      const { entry: mine } = await logs.commit(userId, entry());
      const [other] = await pg.db
        .insert(schema.users)
        .values({ email: `nosy-${randomUUID()}@example.com` })
        .returning({ id: schema.users.id });

      await expect(logs.getById(other!.id, mine.id)).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });

    it('will not delete another user entry', async () => {
      const { entry: mine } = await logs.commit(userId, entry());
      const [other] = await pg.db
        .insert(schema.users)
        .values({ email: `nosy2-${randomUUID()}@example.com` })
        .returning({ id: schema.users.id });

      await expect(logs.remove(other!.id, mine.id)).rejects.toMatchObject({
        problem: { status: 404 },
      });
      await expect(logs.getById(userId, mine.id)).resolves.toBeDefined();
    });
  });
});
