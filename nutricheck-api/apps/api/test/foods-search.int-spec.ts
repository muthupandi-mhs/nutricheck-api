import { ingestUsda } from '@nutricheck/ingest';
import { eq, schema } from '@nutricheck/database';
import { join } from 'node:path';
import { FoodsService } from '../src/modules/foods/foods.service';
import { startTestPostgres, type TestDatabase } from './postgres';

const FIXTURES = join(__dirname, '..', '..', '..', 'tools', 'ingest', 'fixtures');

describe('corpus ingest + search', () => {
  let pg: TestDatabase;
  let foods: FoodsService;
  let userId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    foods = new FoodsService(pg.db);

    await ingestUsda(pg.db, FIXTURES);

    const [user] = await pg.db
      .insert(schema.users)
      .values({ email: 'search-int@example.com' })
      .returning({ id: schema.users.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await pg?.stop();
  });

  describe('ingest', () => {
    it('loads every fixture food', async () => {
      const rows = await pg.db.select({ id: schema.foods.id }).from(schema.foods);
      expect(rows).toHaveLength(13);
    });

    it('is idempotent - re-running does not duplicate rows', async () => {
      // The upsert key is (source, source_id). A re-ingest of the same release
      // must be a no-op, because it happens every time USDA reissues data.
      await ingestUsda(pg.db, FIXTURES);
      const rows = await pg.db.select({ id: schema.foods.id }).from(schema.foods);
      expect(rows).toHaveLength(13);
    });

    it('records fiber as unknown, never zero, when USDA does not report it', async () => {
      // The trap: treating a missing value as 0 under-reports the headline
      // fiber number every single day, invisibly.
      const [chicken] = await pg.db
        .select({
          fiberG: schema.foodNutrients.fiberG,
          fiberState: schema.foodNutrients.fiberState,
        })
        .from(schema.foods)
        .innerJoin(schema.foodNutrients, eq(schema.foodNutrients.foodId, schema.foods.id))
        .where(eq(schema.foods.sourceId, '747447'));

      expect(chicken).toEqual({ fiberG: null, fiberState: 'unknown' });
    });

    it('keeps a reported zero as a known zero', async () => {
      // A measured 0.0 is a fact; absence is not. These must not collapse.
      const [egg] = await pg.db
        .select({
          fiberG: schema.foodNutrients.fiberG,
          fiberState: schema.foodNutrients.fiberState,
        })
        .from(schema.foods)
        .innerJoin(schema.foodNutrients, eq(schema.foodNutrients.foodId, schema.foods.id))
        .where(eq(schema.foods.sourceId, '173424'));

      expect(egg).toEqual({ fiberG: 0, fiberState: 'known' });
    });

    it('maps household portions with their gram weights', async () => {
      const [apple] = await pg.db
        .select({ id: schema.foods.id })
        .from(schema.foods)
        .where(eq(schema.foods.sourceId, '171688'));

      const detail = await foods.findById(apple!.id);
      expect(detail.portions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '1 medium (approx 3 per lb)', grams: 182 }),
        ]),
      );
      // The first portion is the default, so the confirm sheet can prefill
      // without guessing.
      expect(detail.portions[0]?.isDefault).toBe(true);
    });
  });

  describe('search', () => {
    it('finds a food by a single word from a long USDA description', async () => {
      const results = await foods.search(userId, 'lentils', 10);
      expect(results[0]?.name).toContain('Lentils');
    });

    it('finds a regional dish by the name people actually say', async () => {
      const results = await foods.search(userId, 'roti', 10);
      expect(results[0]?.name).toContain('Chapati or roti');
    });

    it('returns the default portion alongside the row', async () => {
      // Calories and a portion in the result row mean choosing between four
      // similar entries does not require opening each one.
      const [apple] = await foods.search(userId, 'apple', 10);
      expect(apple?.defaultPortion).toEqual({
        label: '1 medium (approx 3 per lb)',
        grams: 182,
        isDefault: true,
      });
    });

    it('is case and punctuation insensitive', async () => {
      const plain = await foods.search(userId, 'spinach', 10);
      const shouty = await foods.search(userId, '  SPINACH!! ', 10);
      expect(shouty.map((r) => r.id)).toEqual(plain.map((r) => r.id));
    });

    it('returns nothing rather than everything for an unmatched phrase', async () => {
      // A miss must be a miss. Returning loosely related rows is how someone
      // ends up logging the wrong food.
      const results = await foods.search(userId, 'xylophone', 10);
      expect(results).toEqual([]);
    });

    it('returns an empty list for a query that normalizes to nothing', async () => {
      expect(await foods.search(userId, '!!!', 10)).toEqual([]);
    });

    it('respects the limit', async () => {
      const results = await foods.search(userId, 'chicken', 1);
      expect(results).toHaveLength(1);
    });

    it('marks nothing as familiar for a user with no history', async () => {
      const results = await foods.search(userId, 'chicken', 10);
      expect(results.every((r) => r.familiarity === 'none')).toBe(true);
    });

    it('promotes a food the user has logged before', async () => {
      // The two chicken entries score almost identically on text similarity, so
      // that signal alone cannot separate them. Having logged one should.
      const before = await foods.search(userId, 'chicken', 10);
      const runnerUp = before[1];
      expect(runnerUp).toBeDefined();

      const [entry] = await pg.db
        .insert(schema.logEntries)
        .values({
          clientId: '11111111-1111-4111-8111-111111111111',
          userId,
          loggedAt: new Date(),
          meal: 'lunch',
          source: 'search',
        })
        .returning({ id: schema.logEntries.id });

      await pg.db.insert(schema.logItems).values({
        entryId: entry!.id,
        foodId: runnerUp!.id,
        grams: 150,
        kcal: 180,
        proteinG: 33,
        fiberG: null,
        fiberState: 'unknown',
        quantityType: 'exact_mass',
        quantitySource: 'stated',
      });

      const after = await foods.search(userId, 'chicken', 10);
      expect(after[0]?.id).toBe(runnerUp!.id);
      expect(after[0]?.familiarity).toBe('logged');
    });

    it('scopes familiarity to the user who logged it', async () => {
      // Another user's history must never leak into these results.
      const [other] = await pg.db
        .insert(schema.users)
        .values({ email: 'other-int@example.com' })
        .returning({ id: schema.users.id });

      const results = await foods.search(other!.id, 'chicken', 10);
      expect(results.every((r) => r.familiarity === 'none')).toBe(true);
    });
  });

  describe('findById', () => {
    it('raises a 404 problem for an unknown id', async () => {
      await expect(
        foods.findById('00000000-0000-4000-8000-000000000000'),
      ).rejects.toMatchObject({ problem: { status: 404 } });
    });
  });
});
