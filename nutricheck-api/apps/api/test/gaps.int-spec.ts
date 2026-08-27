import type { CommitLogEntry, UserProfile } from '@nutricheck/contracts';
import { eq, schema } from '@nutricheck/database';
import { ingestUsda } from '@nutricheck/ingest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FoodsService } from '../src/modules/foods/foods.service';
import { GoalsService } from '../src/modules/goals/goals.service';
import { LogsService } from '../src/modules/logs/logs.service';
import { MealsService } from '../src/modules/meals/meals.service';
import { SuggestionsService } from '../src/modules/suggestions/suggestions.service';
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

/**
 * The four client/backend gaps from GAP-REPORT.STATUS.md §3.
 *
 * Each of these existed as a method on `NutriCheckApi` with nothing behind it,
 * so the tests are written from the client's side of the seam: what the app
 * calls, and what it needs back to render.
 */
describe('client/backend gaps', () => {
  let pg: TestDatabase;
  let foods: FoodsService;
  let goals: GoalsService;
  let logs: LogsService;
  let meals: MealsService;
  let suggestions: SuggestionsService;
  let lentilsId: string;
  let rotiId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    goals = new GoalsService(pg.db);
    foods = new FoodsService(pg.db);
    logs = new LogsService(pg.db, goals);
    meals = new MealsService(pg.db, logs);
    suggestions = new SuggestionsService(pg.db);

    await ingestUsda(pg.db, FIXTURES);
    lentilsId = await foodIdBySourceId('169705');
    rotiId = await foodIdBySourceId('172730');
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
          grams: 100,
          quantityType: 'exact_mass',
          quantitySource: 'stated',
          learnedUnitLabel: null,
        },
      ],
      ...overrides,
    };
  }

  // §3.3 ────────────────────────────────────────────────────────────────────
  describe('previewGoal', () => {
    it('derives the same targets the persisting path would', async () => {
      // The whole point: one formula. If these can differ, the targets screen
      // shows a number the user does not get when they accept it.
      const userId = await newUser('preview');
      const preview = goals.previewGoal(PROFILE);

      await goals.upsertProfile(userId, PROFILE);
      const saved = await goals.currentGoal(userId);

      expect(preview.kcal).toBe(saved.kcal);
      expect(preview.proteinG).toBe(saved.proteinG);
      expect(preview.carbsG).toBe(saved.carbsG);
      expect(preview.fatG).toBe(saved.fatG);
      expect(preview.fiberG).toBe(saved.fiberG);
      expect(preview.basis).toEqual(saved.basis);
    });

    it('writes nothing', async () => {
      const userId = await newUser('preview-clean');

      goals.previewGoal(PROFILE);
      goals.previewGoal({ ...PROFILE, weightKg: 95 });

      const rows = await pg.db
        .select()
        .from(schema.goals)
        .where(eq(schema.goals.userId, userId));
      expect(rows).toHaveLength(0);
    });

    it('tracks the profile it is given, not the one on file', async () => {
      // This is what makes a live recompute possible while the user is still
      // dragging a slider and has saved nothing.
      const lighter = goals.previewGoal({ ...PROFILE, weightKg: 60 });
      const heavier = goals.previewGoal({ ...PROFILE, weightKg: 100 });
      expect(heavier.kcal).toBeGreaterThan(lighter.kcal);
    });
  });

  // §3.4 ────────────────────────────────────────────────────────────────────
  describe('updateItemGrams', () => {
    it('changes one portion and leaves its siblings alone', async () => {
      const userId = await newUser('item');
      const { entry: committed } = await logs.commit(
        userId,
        entry({
          items: [
            {
              foodId: lentilsId,
              grams: 100,
              quantityType: 'exact_mass',
              quantitySource: 'stated',
              learnedUnitLabel: null,
            },
            {
              foodId: rotiId,
              grams: 50,
              quantityType: 'exact_mass',
              quantitySource: 'stated',
              learnedUnitLabel: null,
            },
          ],
        }),
      );

      const target = committed.items[0]!;
      const untouched = committed.items[1]!;

      const updated = await logs.updateItem(userId, committed.id, target.id, {
        grams: 200,
        learnedUnitLabel: null,
      });

      const after = updated.items.find((i) => i.id === target.id)!;
      const sibling = updated.items.find((i) => i.id === untouched.id)!;

      expect(after.grams).toBe(200);
      // Re-frozen from the corpus, not scaled client-side.
      expect(after.nutrients.kcal).toBe(target.nutrients.kcal * 2);
      expect(sibling.grams).toBe(untouched.grams);
      expect(sibling.nutrients.kcal).toBe(untouched.nutrients.kcal);
    });

    it('marks the corrected portion as stated', async () => {
      const userId = await newUser('item-stated');
      const { entry: committed } = await logs.commit(
        userId,
        entry({
          items: [
            {
              foodId: lentilsId,
              grams: 198,
              quantityType: 'standard_measure',
              quantitySource: 'food_portion',
              learnedUnitLabel: null,
            },
          ],
        }),
      );

      const updated = await logs.updateItem(
        userId,
        committed.id,
        committed.items[0]!.id,
        { grams: 150, learnedUnitLabel: null },
      );

      // It was an inference from a portion table; the user has now stated it.
      expect(updated.items[0]!.quantitySource).toBe('stated');
    });

    it('learns the personal unit — the reason this route exists', async () => {
      const userId = await newUser('item-learn');
      const { entry: committed } = await logs.commit(userId, entry());

      await logs.updateItem(userId, committed.id, committed.items[0]!.id, {
        grams: 180,
        learnedUnitLabel: 'a bowl',
      });

      const [learned] = await pg.db
        .select()
        .from(schema.userPortions)
        .where(eq(schema.userPortions.userId, userId));

      expect(learned?.unitLabel).toBe('a bowl');
      expect(learned?.grams).toBe(180);
    });

    it('counts a repeated correction rather than overwriting it silently', async () => {
      const userId = await newUser('item-learn-twice');
      const first = await logs.commit(userId, entry());
      const second = await logs.commit(userId, entry());

      await logs.updateItem(userId, first.entry.id, first.entry.items[0]!.id, {
        grams: 180,
        learnedUnitLabel: 'a bowl',
      });
      await logs.updateItem(userId, second.entry.id, second.entry.items[0]!.id, {
        grams: 200,
        learnedUnitLabel: 'a bowl',
      });

      const [learned] = await pg.db
        .select()
        .from(schema.userPortions)
        .where(eq(schema.userPortions.userId, userId));

      expect(learned?.grams).toBe(200);
      expect(learned?.nCorrections).toBeGreaterThan(1);
    });

    it('refuses an item id that belongs to a different entry', async () => {
      // Otherwise a known item id would be editable from any entry the caller
      // happens to own, and across accounts it would be worse than that.
      const userId = await newUser('item-scope');
      const mine = await logs.commit(userId, entry());
      const other = await logs.commit(userId, entry());

      await expect(
        logs.updateItem(userId, mine.entry.id, other.entry.items[0]!.id, {
          grams: 120,
          learnedUnitLabel: null,
        }),
      ).rejects.toThrow();
    });

    it("refuses another user's entry", async () => {
      const owner = await newUser('item-owner');
      const stranger = await newUser('item-stranger');
      const { entry: committed } = await logs.commit(owner, entry());

      await expect(
        logs.updateItem(stranger, committed.id, committed.items[0]!.id, {
          grams: 120,
          learnedUnitLabel: null,
        }),
      ).rejects.toThrow();
    });
  });

  // §3.2 ────────────────────────────────────────────────────────────────────
  describe('getPhrases', () => {
    it('records the sentence that produced an entry', async () => {
      // Before this, user_phrases was written by nothing and answered empty
      // forever however many sentences the user had said.
      const userId = await newUser('phrase');
      await logs.commit(userId, entry({ phrase: 'a bowl of dal' }));

      const phrases = await suggestions.phrases(userId, 12);
      expect(phrases).toHaveLength(1);
      expect(phrases[0]!.phrase).toBe('a bowl of dal');
      expect(phrases[0]!.useCount).toBe(1);
    });

    it('counts a repeat instead of listing it twice', async () => {
      const userId = await newUser('phrase-repeat');
      await logs.commit(userId, entry({ phrase: 'two rotis' }));
      await logs.commit(userId, entry({ phrase: 'two rotis' }));

      const phrases = await suggestions.phrases(userId, 12);
      expect(phrases).toHaveLength(1);
      // Second use is when the composer offers to save it as a meal.
      expect(phrases[0]!.useCount).toBe(2);
    });

    it('ignores an entry with no phrase, so a repeat-tap cannot pad the list', async () => {
      const userId = await newUser('phrase-none');
      await logs.commit(userId, entry({ phrase: null, source: 'repeat' }));

      expect(await suggestions.phrases(userId, 12)).toHaveLength(0);
    });

    it('reports the calories of the most recent entry for that phrase', async () => {
      const userId = await newUser('phrase-kcal');
      await logs.commit(userId, entry({ phrase: 'dal', loggedAt: '2026-08-20T12:00:00.000Z' }));
      await logs.commit(
        userId,
        entry({
          phrase: 'dal',
          loggedAt: '2026-08-25T12:00:00.000Z',
          items: [
            {
              foodId: lentilsId,
              grams: 300,
              quantityType: 'exact_mass',
              quantitySource: 'stated',
              learnedUnitLabel: null,
            },
          ],
        }),
      );

      const [phrase] = await suggestions.phrases(userId, 12);
      const day = await logs.day(userId, '2026-08-25', 'UTC');
      // The number beside the sentence is the last one the user accepted.
      expect(phrase!.kcal).toBe(Math.round(day.totals.kcal));
    });

    it('shows the saved meal name once the phrase is promoted', async () => {
      const userId = await newUser('phrase-promote');
      const { entry: committed } = await logs.commit(
        userId,
        entry({ phrase: 'usual breakfast' }),
      );

      const before = await suggestions.phrases(userId, 12);
      expect(before[0]!.savedAs).toBeNull();

      await meals.create(userId, {
        name: 'Usual breakfast',
        fromEntryId: committed.id,
      });

      const after = await suggestions.phrases(userId, 12);
      // The composer now renders a bookmark and the meal name over the sentence.
      expect(after[0]!.savedAs).toBe('Usual breakfast');
    });

    it('keeps a hand-built meal from claiming an unrelated phrase', async () => {
      const userId = await newUser('phrase-handbuilt');
      await logs.commit(userId, entry({ phrase: 'rice and dal' }));

      await meals.create(userId, {
        name: 'Something else',
        items: [{ foodId: rotiId, grams: 60, quantityType: 'exact_mass' }],
      });

      const phrases = await suggestions.phrases(userId, 12);
      expect(phrases[0]!.savedAs).toBeNull();
    });

    it('lists the most recently used sentence first', async () => {
      const userId = await newUser('phrase-order');
      await logs.commit(userId, entry({ phrase: 'older' }));
      await logs.commit(userId, entry({ phrase: 'newer' }));

      const phrases = await suggestions.phrases(userId, 12);
      expect(phrases.map((p) => p.phrase)).toEqual(['newer', 'older']);
    });

    it("does not leak another user's phrases", async () => {
      const mine = await newUser('phrase-mine');
      const theirs = await newUser('phrase-theirs');
      await logs.commit(theirs, entry({ phrase: 'their sentence' }));

      expect(await suggestions.phrases(mine, 12)).toHaveLength(0);
    });
  });

  // §3.1 ────────────────────────────────────────────────────────────────────
  describe('getWeek', () => {
    it('returns seven days ending on the requested date, gaps included', async () => {
      const userId = await newUser('week');
      await goals.upsertProfile(userId, PROFILE);
      await logs.commit(userId, entry({ loggedAt: '2026-08-26T12:00:00.000Z' }));
      await logs.commit(userId, entry({ loggedAt: '2026-08-24T12:00:00.000Z' }));

      const week = await logs.week(userId, '2026-08-26', 'UTC');

      expect(week.from).toBe('2026-08-20');
      expect(week.to).toBe('2026-08-26');
      // Seven bars whatever the data does — a missing day renders empty rather
      // than shifting its neighbours along the axis.
      expect(week.days).toHaveLength(7);
      expect(week.days.map((d) => d.date)).toEqual([
        '2026-08-20',
        '2026-08-21',
        '2026-08-22',
        '2026-08-23',
        '2026-08-24',
        '2026-08-25',
        '2026-08-26',
      ]);
      expect(week.days.filter((d) => d.logged).map((d) => d.date)).toEqual([
        '2026-08-24',
        '2026-08-26',
      ]);
    });

    it('matches the day view for the same date', async () => {
      // A bar on the chart must contain exactly what the day screen shows, or
      // one of the two is lying about the same Tuesday.
      const userId = await newUser('week-agrees');
      await goals.upsertProfile(userId, PROFILE);
      await logs.commit(userId, entry({ loggedAt: '2026-08-26T12:00:00.000Z' }));

      const week = await logs.week(userId, '2026-08-26', 'UTC');
      const day = await logs.day(userId, '2026-08-26', 'UTC');
      const point = week.days.find((d) => d.date === '2026-08-26')!;

      expect(point.kcal).toBe(day.totals.kcal);
      expect(point.proteinG).toBe(day.totals.proteinG);
      expect(point.carbsG).toBe(day.totals.carbsG);
      expect(point.fatG).toBe(day.totals.fatG);
      expect(point.fiberG).toBe(day.totals.fiberG);
    });

    it('averages over logged days only', async () => {
      const userId = await newUser('week-avg');
      await goals.upsertProfile(userId, PROFILE);
      await logs.commit(userId, entry({ loggedAt: '2026-08-26T12:00:00.000Z' }));
      await logs.commit(userId, entry({ loggedAt: '2026-08-25T12:00:00.000Z' }));

      const week = await logs.week(userId, '2026-08-26', 'UTC');
      const logged = week.days.filter((d) => d.logged);
      const expected =
        logged.reduce((sum, d) => sum + d.kcal, 0) / logged.length;

      // Dividing by seven would punish someone for days they never claimed.
      expect(week.averages.kcal).toBeCloseTo(expected, 1);
      expect(week.averages.kcal).toBeGreaterThan(0);
    });

    it('reports zero averages rather than NaN for an empty week', async () => {
      const userId = await newUser('week-empty');
      const week = await logs.week(userId, '2026-08-26', 'UTC');

      expect(week.averages).toEqual({
        kcal: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        fiberG: 0,
      });
      expect(week.days.every((d) => !d.logged)).toBe(true);
      expect(week.streakDays).toBe(0);
    });

    it('reports the goal in effect at the end of the window, not the current one', async () => {
      // A week viewed in hindsight is measured against the target that was
      // actually in force, or a weight change retroactively rewrites whether
      // last month was a good month.
      const userId = await newUser('week-goal');
      await goals.upsertProfile(userId, PROFILE);
      // Backdated on purpose. upsertProfile derives a goal effective TODAY, and
      // every date in this suite is fixed at 2026-08-26 -- so from the day after
      // these tests were written the goal did not yet exist on the date being
      // queried, and the assertion failed for the rest of time. The app was
      // right to report zero; the test was asking about a day before the user
      // had a goal.
      await goals.override(userId, { effectiveFrom: '2026-08-01' });
      const original = (await goals.currentGoal(userId)).kcal;

      await goals.override(userId, { kcal: 1500, effectiveFrom: '2026-09-01' });

      const before = await logs.week(userId, '2026-08-26', 'UTC');
      expect(before.goal.kcal).toBe(original);

      const after = await logs.week(userId, '2026-09-05', 'UTC');
      expect(after.goal.kcal).toBe(1500);
    });

    it('falls back to zeros when the user has no goal yet', async () => {
      const userId = await newUser('week-nogoal');
      const week = await logs.week(userId, '2026-08-26', 'UTC');
      expect(week.goal).toEqual({
        kcal: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        fiberG: 0,
      });
    });

    it('buckets by the user timezone, not UTC', async () => {
      // 23:30 in Asia/Kolkata is 18:00 UTC the same day. Bucketing in UTC puts
      // this on the right date by luck; the next case is the one that bites.
      const userId = await newUser('week-tz');
      await logs.commit(userId, entry({ loggedAt: '2026-08-25T20:00:00.000Z' }));

      const utc = await logs.week(userId, '2026-08-26', 'UTC');
      const kolkata = await logs.week(userId, '2026-08-26', 'Asia/Kolkata');

      // 20:00 UTC on the 25th is 01:30 on the 26th in Kolkata.
      expect(utc.days.find((d) => d.date === '2026-08-25')!.logged).toBe(true);
      expect(kolkata.days.find((d) => d.date === '2026-08-26')!.logged).toBe(true);
      expect(kolkata.days.find((d) => d.date === '2026-08-25')!.logged).toBe(false);
    });

    it('counts a streak back from the anchor and stops at the first gap', async () => {
      const userId = await newUser('week-streak');
      for (const date of ['2026-08-26', '2026-08-25', '2026-08-24']) {
        await logs.commit(userId, entry({ loggedAt: `${date}T12:00:00.000Z` }));
      }
      // 08-23 deliberately missing.
      await logs.commit(userId, entry({ loggedAt: '2026-08-22T12:00:00.000Z' }));

      const week = await logs.week(userId, '2026-08-26', 'UTC');
      expect(week.streakDays).toBe(3);
    });

    it('is not capped by the seven-day window', async () => {
      // A fourteen-day streak reports fourteen. Capping it at the chart width
      // would make the number meaningless exactly when it starts mattering.
      const userId = await newUser('week-long-streak');
      for (let i = 0; i < 10; i += 1) {
        const date = new Date(Date.UTC(2026, 7, 26) - i * 86_400_000)
          .toISOString()
          .slice(0, 10);
        await logs.commit(userId, entry({ loggedAt: `${date}T12:00:00.000Z` }));
      }

      const week = await logs.week(userId, '2026-08-26', 'UTC');
      expect(week.streakDays).toBe(10);
    });

    it('reads zero when the anchor day itself has no entry', async () => {
      // The literal reading of "counting back from today", and the reason the
      // streak reads zero all morning. Documented, not accidental.
      const userId = await newUser('week-streak-broken');
      await logs.commit(userId, entry({ loggedAt: '2026-08-25T12:00:00.000Z' }));

      const week = await logs.week(userId, '2026-08-26', 'UTC');
      expect(week.streakDays).toBe(0);
    });

    it("does not count another user's days", async () => {
      const mine = await newUser('week-mine');
      const theirs = await newUser('week-theirs');
      await logs.commit(theirs, entry({ loggedAt: '2026-08-26T12:00:00.000Z' }));

      const week = await logs.week(mine, '2026-08-26', 'UTC');
      expect(week.days.every((d) => !d.logged)).toBe(true);
    });
  });
});
