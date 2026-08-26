import type { CommitLogEntry } from '@nutricheck/contracts';
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

describe('core M1 features', () => {
  let pg: TestDatabase;
  let foods: FoodsService;
  let logs: LogsService;
  let meals: MealsService;
  let suggestions: SuggestionsService;
  let userId: string;
  let lentilsId: string;
  let rotiId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const goals = new GoalsService(pg.db);
    foods = new FoodsService(pg.db);
    logs = new LogsService(pg.db, goals);
    meals = new MealsService(pg.db, logs);
    suggestions = new SuggestionsService(pg.db);

    await ingestUsda(pg.db, FIXTURES);
    userId = await newUser();
    lentilsId = await foodIdBySourceId('169705');
    rotiId = await foodIdBySourceId('172730');
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function newUser(): Promise<string> {
    const [user] = await pg.db
      .insert(schema.users)
      .values({ email: `core-${randomUUID()}@example.com` })
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
          grams: 198,
          quantityType: 'standard_measure',
          quantitySource: 'food_portion',
          learnedUnitLabel: null,
        },
      ],
      ...overrides,
    };
  }

  describe('custom foods', () => {
    it('creates a food the corpus does not have', async () => {
      const food = await foods.createCustom(userId, {
        name: 'Mums dal',
        brand: null,
        per100g: {
          kcal: 140,
          proteinG: 7.5,
          carbsG: 18,
          carbsState: 'known',
          fatG: 4,
          fatState: 'known',
          fiberG: null,
          fiberState: 'unknown',
        },
        defaultPortionGrams: 210,
      });

      expect(food.name).toBe('Mums dal');
      expect(food.portions[0]).toMatchObject({ grams: 210, isDefault: true });
    });

    it('keeps fiber unknown when the user does not supply it', async () => {
      const food = await foods.createCustom(userId, {
        name: `No fiber ${randomUUID()}`,
        brand: null,
        per100g: {
          kcal: 100,
          proteinG: 3,
          carbsG: null,
          carbsState: 'unknown',
          fatG: null,
          fatState: 'unknown',
          fiberG: null,
          fiberState: 'unknown',
        },
        defaultPortionGrams: null,
      });
      expect(food.nutrients.fiberG).toBeNull();
      expect(food.nutrients.fiberState).toBe('unknown');
      expect(food.nutrients.carbsG).toBeNull();
      expect(food.nutrients.carbsState).toBe('unknown');
      expect(food.nutrients.fatG).toBeNull();
      expect(food.nutrients.fatState).toBe('unknown');
    });

    it('surfaces the custom food in its owner search', async () => {
      const results = await foods.search(userId, 'mums dal', 10);
      expect(results.some((r) => r.name === 'Mums dal')).toBe(true);
    });

    it('marks it as a custom food so the strip can rank it above corpus rows', async () => {
      const [top] = await foods.search(userId, 'mums dal', 10);
      expect(top?.familiarity).toBe('custom');
    });

    it('hides it from every other user', async () => {
      // source='user' says how the row got here, not who owns it. Without the
      // created_by filter one person's "Mum's dal" is in everyone's search.
      const stranger = await newUser();
      const results = await foods.search(stranger, 'mums dal', 10);
      expect(results).toEqual([]);
    });

    it('lets two users name a dish the same thing', async () => {
      const other = await newUser();
      await expect(
        foods.createCustom(other, {
          name: 'Mums dal',
          brand: null,
          per100g: {
            kcal: 150,
            proteinG: 8,
            carbsG: 20,
            carbsState: 'known',
            fatG: 4,
            fatState: 'known',
            fiberG: 2,
            fiberState: 'known',
          },
          defaultPortionGrams: null,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('editing an entry', () => {
    it('recomputes and re-freezes nutrients from the corpus', async () => {
      const { entry: saved } = await logs.commit(userId, entry());
      expect(saved.items[0]?.nutrients.kcal).toBe(229.68);

      const updated = await logs.update(userId, saved.id, {
        items: [
          {
            foodId: lentilsId,
            grams: 300,
            quantityType: 'exact_mass',
            quantitySource: 'stated',
            learnedUnitLabel: null,
          },
        ],
      });

      // 116 kcal/100g x 300 g. Not scaled from the old value — recomputed.
      expect(updated.items[0]?.nutrients.kcal).toBe(348);
      expect(updated.items).toHaveLength(1);
    });

    it('replaces items wholesale rather than appending', async () => {
      const { entry: saved } = await logs.commit(userId, entry());
      const updated = await logs.update(userId, saved.id, {
        items: [
          {
            foodId: rotiId,
            grams: 45,
            quantityType: 'count',
            quantitySource: 'food_portion',
            learnedUnitLabel: null,
          },
        ],
      });

      expect(updated.items).toHaveLength(1);
      expect(updated.items[0]?.food.id).toBe(rotiId);
    });

    it('moves an entry between meals without touching its items', async () => {
      const { entry: saved } = await logs.commit(userId, entry());
      const updated = await logs.update(userId, saved.id, { meal: 'dinner' });

      expect(updated.meal).toBe('dinner');
      expect(updated.items[0]?.nutrients.kcal).toBe(229.68);
    });

    it('refuses to edit another user entry', async () => {
      const { entry: mine } = await logs.commit(userId, entry());
      const stranger = await newUser();

      await expect(
        logs.update(stranger, mine.id, { meal: 'dinner' }),
      ).rejects.toMatchObject({ problem: { status: 404 } });
    });
  });

  describe('saved meals', () => {
    it('saves an entry that already worked as a meal', async () => {
      const { entry: saved } = await logs.commit(userId, entry());
      const meal = await meals.create(userId, {
        name: 'Usual lunch',
        fromEntryId: saved.id,
      });

      expect(meal.name).toBe('Usual lunch');
      expect(meal.items).toHaveLength(1);
      expect(meal.totals.kcal).toBeCloseTo(229.68, 1);
    });

    it('logs every item at once through the ordinary commit path', async () => {
      const meal = await meals.create(userId, {
        name: `Two item ${randomUUID()}`,
        items: [
          { foodId: lentilsId, grams: 100, quantityType: 'exact_mass' },
          { foodId: rotiId, grams: 45, quantityType: 'count' },
        ],
      });

      const { entry: logged, created } = await meals.log(userId, meal.id, {
        clientId: randomUUID(),
        loggedAt: '2026-08-26T13:00:00.000Z',
        meal: 'lunch',
      });

      expect(created).toBe(true);
      expect(logged.items).toHaveLength(2);
      // 'repeat' is the source that bypasses the confirm sheet — there is no
      // estimate to check, only portions the user set themselves.
      expect(logged.source).toBe('repeat');
    });

    it('inherits idempotency from the commit path', async () => {
      // There must be exactly one code path that writes a log entry.
      const meal = await meals.create(userId, {
        name: `Idem ${randomUUID()}`,
        items: [{ foodId: rotiId, grams: 45, quantityType: 'count' }],
      });
      const request = {
        clientId: randomUUID(),
        loggedAt: '2026-08-26T13:00:00.000Z',
        meal: 'lunch' as const,
      };

      const first = await meals.log(userId, meal.id, request);
      const replay = await meals.log(userId, meal.id, request);

      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.entry.id).toBe(first.entry.id);
    });

    it('refuses to read another user meal', async () => {
      const meal = await meals.create(userId, {
        name: `Private ${randomUUID()}`,
        items: [{ foodId: rotiId, grams: 45, quantityType: 'count' }],
      });
      const stranger = await newUser();

      await expect(meals.findById(stranger, meal.id)).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });
  });

  describe('the repeat strip', () => {
    let stripUser: string;

    beforeAll(async () => {
      stripUser = await newUser();

      // Roti every morning, lentils every evening.
      for (const day of [21, 22, 23]) {
        await logs.commit(stripUser, {
          ...entry(),
          clientId: randomUUID(),
          loggedAt: `2026-08-${day}T08:00:00.000Z`,
          meal: 'breakfast',
          items: [
            {
              foodId: rotiId,
              grams: 90,
              quantityType: 'count',
              quantitySource: 'food_portion',
              learnedUnitLabel: null,
            },
          ],
        });
        await logs.commit(stripUser, {
          ...entry(),
          clientId: randomUUID(),
          loggedAt: `2026-08-${day}T19:30:00.000Z`,
          meal: 'dinner',
          items: [
            {
              foodId: lentilsId,
              grams: 250,
              quantityType: 'exact_mass',
              quantitySource: 'stated',
              learnedUnitLabel: null,
            },
          ],
        });
      }
    });

    it('returns what the user actually eats', async () => {
      const strip = await suggestions.recents(stripUser, 10);
      const foodIds = strip
        .filter((s) => s.kind === 'food')
        .map((s) => (s.kind === 'food' ? s.food.id : ''));
      expect(foodIds).toEqual(expect.arrayContaining([rotiId, lentilsId]));
    });

    it('carries the last portion so one tap needs no portion picker', async () => {
      const strip = await suggestions.recents(stripUser, 10);
      const roti = strip.find((s) => s.kind === 'food' && s.food.id === rotiId);
      expect(roti).toMatchObject({ kind: 'food', grams: 90, timesLogged: 3 });
    });

    it('leads with breakfast food in the morning', async () => {
      const strip = await suggestions.recents(stripUser, 10, 8);
      const first = strip.find((s) => s.kind === 'food');
      expect(first).toMatchObject({ kind: 'food', food: { id: rotiId } });
    });

    it('leads with dinner food in the evening', async () => {
      // The signal has to be applied to the FINAL score. Using it only to pick
      // SQL candidates selects the right rows and then throws it away.
      const strip = await suggestions.recents(stripUser, 10, 19);
      const first = strip.find((s) => s.kind === 'food');
      expect(first).toMatchObject({ kind: 'food', food: { id: lentilsId } });
    });

    it('still returns both foods outside their usual hours', async () => {
      // Out-of-window rows are penalised, not excluded — the strip must never
      // be short just because someone is eating at an odd time.
      const strip = await suggestions.recents(stripUser, 10, 3);
      const ids = strip.filter((s) => s.kind === 'food').map((s) => (s.kind === 'food' ? s.food.id : ''));
      expect(ids).toEqual(expect.arrayContaining([rotiId, lentilsId]));
    });

    it('includes saved meals alongside foods', async () => {
      await meals.create(stripUser, {
        name: 'Usual breakfast',
        items: [{ foodId: rotiId, grams: 90, quantityType: 'count' }],
      });

      const strip = await suggestions.recents(stripUser, 10);
      expect(strip.some((s) => s.kind === 'meal' && s.name === 'Usual breakfast')).toBe(true);
    });

    it('respects the limit', async () => {
      const strip = await suggestions.recents(stripUser, 1);
      expect(strip).toHaveLength(1);
    });

    it('is empty for a user with no history', async () => {
      expect(await suggestions.recents(await newUser(), 10)).toEqual([]);
    });

    it('does not leak another user history', async () => {
      const stranger = await newUser();
      expect(await suggestions.recents(stranger, 10, 8)).toEqual([]);
    });
  });
});
