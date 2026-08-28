import type { MealFacts } from '@nutricheck/contracts';
import { eq, schema } from '@nutricheck/database';
import { ingestUsda } from '@nutricheck/ingest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { AiRunsService } from '../src/modules/ai/ai-runs.service';
import {
  AiRefusedError,
  AiService,
  AiUnavailableError,
  type AiCallResult,
  type RerankItem,
} from '../src/modules/ai/ai.service';
import type {
  AiMealResult,
  IdeasResult,
  IdentifyResult,
  InsightResult,
  ParseResult,
  RerankResult,
  TargetsResult,
} from '../src/modules/ai/ai.schemas';
import { FoodsService } from '../src/modules/foods/foods.service';
import { GoalsService } from '../src/modules/goals/goals.service';
import { LogsService } from '../src/modules/logs/logs.service';
import { QuotaService } from '../src/modules/quota/quota.service';
import { DraftStoreService } from '../src/modules/resolver/draft-store.service';
import { PortionPrefillService } from '../src/modules/resolver/portion-prefill.service';
import {
  ResolverService,
  resolveAgainstFood,
} from '../src/modules/resolver/resolver.service';
import { startTestPostgres, type TestDatabase } from './postgres';

const FIXTURES = join(__dirname, '..', '..', '..', 'tools', 'ingest', 'fixtures');

/**
 * A scripted stand-in for the model.
 *
 * The entire point of AiService being an abstract class: the pipeline — portion
 * prefill, batched candidate search, the constrained pick, the arithmetic, the
 * cache, the miss log — is exercised end to end against real Postgres and real
 * Redis, with zero network and zero cost, and the failure modes that must not
 * crash the resolver can be produced on demand.
 */
class FakeAi extends AiService {
  parseCalls = 0;
  rerankCalls = 0;
  lastKnownUnits: ReadonlyArray<{ label: string; grams: number }> = [];
  parseResult: ParseResult = { items: [], unresolved: [] };
  /** Chooses a candidate id per item index. Defaults to the first. */
  chooser: (item: RerankItem) => { foodId: string; confidence: 'high' | 'low' } = (item) => ({
    foodId: item.candidates[0]!.id,
    confidence: 'high',
  });
  failWith: Error | null = null;

  get isConfigured(): boolean {
    return true;
  }

  async parse(
    _phrase: string,
    knownUnits: ReadonlyArray<{ label: string; grams: number }>,
  ): Promise<AiCallResult<ParseResult>> {
    this.parseCalls += 1;
    this.lastKnownUnits = knownUnits;
    if (this.failWith) throw this.failWith;
    return wrap(this.parseResult, 'parse-v1');
  }

  /**
   * The resolver never calls this. It exists because AiService is abstract and
   * grew the member when the insight endpoint landed, and stubbing it here
   * rather than softening the base class keeps the compiler as the thing that
   * notices the contract changed — which is precisely how this test started
   * failing, and the right way round for it to fail.
   */
  async insight(_facts: MealFacts): Promise<AiCallResult<InsightResult>> {
    return wrap({ text: 'a fake insight' }, 'insight-v1');
  }

  /**
   * Neither suite reaches this. It is here because AiService is abstract and
   * grew the member, and stubbing it rather than softening the base class keeps
   * the compiler as the thing that notices the contract changed.
   */
  async suggestTargets(): Promise<AiCallResult<TargetsResult>> {
    return wrap({ kcal: 2000, proteinG: 120, fiberG: 28, reasoning: 'a fake suggestion' }, 'targets-v1');
  }

  /** Same reason as `suggestTargets`: unreached, stubbed so the compiler stays the guard. */
  async suggestFoods(): Promise<AiCallResult<IdeasResult>> {
    return wrap({ note: 'a fake note', ideas: [] }, 'ideas-v1');
  }
  identifyCalls = 0;
  identifyResult: IdentifyResult = {
    isFood: true,
    names: [],
    script: '',
    confidence: 'low',
  };

  /**
   * Defaults to naming nothing, so the miss path stays the default in every
   * test that has not opted into translation. A fixture that quietly rescues
   * unmatched phrases would hide the behaviour those tests exist to pin.
   */
  async identify(_phrase: string): Promise<AiCallResult<IdentifyResult>> {
    this.identifyCalls += 1;
    if (this.failWith) throw this.failWith;
    return wrap(this.identifyResult, 'identify-v1');
  }

  interpretCalls = 0;
  mealResult: AiMealResult = { summary: '', items: [], unresolved: [] };

  /**
   * The corpus-free path, which this suite does not exercise: every test here
   * pins the behaviour of resolving AGAINST the corpus, and a fake that
   * returned items would quietly make those assertions meaningless.
   */
  async interpretMeal(_phrase: string): Promise<AiCallResult<AiMealResult>> {
    this.interpretCalls += 1;
    if (this.failWith) throw this.failWith;
    return wrap(this.mealResult, 'meal-v1');
  }

  async rerank(items: RerankItem[]): Promise<AiCallResult<RerankResult>> {
    this.rerankCalls += 1;
    if (this.failWith) throw this.failWith;
    return wrap(
      {
        picks: items.map((item) => ({ itemIndex: item.index, ...this.chooser(item) })),
      },
      'rerank-v1',
    );
  }
}

function wrap<T>(value: T, promptVersion: string): AiCallResult<T> {
  return {
    value,
    usage: {
      inputTokens: 50,
      cacheReadTokens: 1200,
      cacheWriteTokens: 0,
      outputTokens: 150,
    },
    latencyMs: 5,
    stopReason: 'end_turn',
    model: 'claude-opus-5',
    promptVersion,
    raw: { fake: true },
  };
}

describe('resolver', () => {
  let pg: TestDatabase;
  let redis: Redis;
  let ai: FakeAi;
  let resolver: ResolverService;
  let foods: FoodsService;
  let logs: LogsService;
  let userId: string;
  let lentilsId: string;
  let rotiId: string;
  let chickenId: string;

  beforeAll(async () => {
    pg = await startTestPostgres();
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      db: 15, // a scratch database, so a test run cannot evict real cache keys
      maxRetriesPerRequest: null,
    });

    await ingestUsda(pg.db, FIXTURES);

    const config = {
      get: (key: string) =>
        ({ RESOLVE_DAILY_QUOTA: 50, RESOLVE_USER_DAILY_SPEND_USD: 1 })[key],
    } as unknown as ConfigService<never, true>;

    ai = new FakeAi();
    foods = new FoodsService(pg.db);
    logs = new LogsService(pg.db, new GoalsService(pg.db));
    const drafts = new DraftStoreService(redis);
    const portions = new PortionPrefillService(pg.db);
    const quota = new QuotaService(pg.db, redis, config);

    resolver = new ResolverService(
      pg.db,
      ai,
      new AiRunsService(pg.db),
      foods,
      portions,
      drafts,
      quota,
    );

    lentilsId = await foodIdBySourceId('169705');
    rotiId = await foodIdBySourceId('172730');
    chickenId = await foodIdBySourceId('747447');
  });

  afterAll(async () => {
    await redis?.flushdb();
    await redis?.quit();
    await pg?.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
    ai.failWith = null;
    ai.parseCalls = 0;
    ai.rerankCalls = 0;
    ai.chooser = (item) => ({ foodId: item.candidates[0]!.id, confidence: 'high' });
    userId = await newUser();
  });

  async function newUser(): Promise<string> {
    const [user] = await pg.db
      .insert(schema.users)
      .values({ email: `resolve-${randomUUID()}@example.com` })
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

  describe('the happy path', () => {
    beforeEach(() => {
      ai.parseResult = {
        items: [
          {
            matchedText: '180g chicken',
            foodPhrase: 'chicken',
            quantityType: 'exact_mass',
            quantityValue: 180,
            quantityUnit: 'g',
          },
        ],
        unresolved: [],
      };
      ai.chooser = () => ({ foodId: chickenId, confidence: 'high' });
    });

    it('turns a phrase into a resolved item with computed nutrients', async () => {
      const draft = await resolver.resolveOnce(userId, {
        phrase: '180g chicken',
        source: 'text',
      });

      expect(draft.items).toHaveLength(1);
      expect(draft.items[0]?.food?.id).toBe(chickenId);
      // 120 kcal/100g x 180 g. Arithmetic, not generation.
      expect(draft.items[0]?.nutrients?.kcal).toBe(216);
    });

    it('carries unmeasured fiber through as unknown rather than zero', async () => {
      const draft = await resolver.resolveOnce(userId, {
        phrase: '180g chicken',
        source: 'text',
      });
      expect(draft.items[0]?.nutrients?.fiberG).toBeNull();
      expect(draft.items[0]?.nutrients?.fiberState).toBe('unknown');
    });

    it('ships every candidate so the runner-up expander is instant', async () => {
      const draft = await resolver.resolveOnce(userId, {
        phrase: '180g chicken',
        source: 'text',
      });
      expect(draft.items[0]?.candidates.length).toBeGreaterThan(1);
    });

    it('writes nothing to the log — a draft is not an entry', async () => {
      await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });
      const entries = await pg.db
        .select({ id: schema.logEntries.id })
        .from(schema.logEntries)
        .where(eq(schema.logEntries.userId, userId));
      expect(entries).toEqual([]);
    });

    it('records an ai_run per model call with a cost', async () => {
      await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });
      const runs = await pg.db
        .select()
        .from(schema.aiRuns)
        .where(eq(schema.aiRuns.userId, userId));

      expect(runs.map((r) => r.step).sort()).toEqual(['parse', 'rerank']);
      expect(Number(runs[0]!.costUsd)).toBeGreaterThan(0);
      expect(runs[0]!.cacheReadTokens).toBe(1200);
    });

    it('streams parsed before resolved so the sheet fills in', async () => {
      const order: string[] = [];
      for await (const event of resolver.resolve(userId, {
        phrase: '180g chicken',
        source: 'text',
      })) {
        order.push(event.event);
      }
      expect(order).toEqual(['parsed', 'resolved', 'done']);
    });
  });

  describe('quantities', () => {
    it('never invents an amount when the phrase gives none', async () => {
      // "Some nuts" specifies nothing. A silent 100 g is where a wrong week starts.
      ai.parseResult = {
        items: [
          {
            matchedText: 'some lentils',
            foodPhrase: 'lentils',
            quantityType: 'none_given',
            quantityValue: null,
            quantityUnit: null,
          },
        ],
        unresolved: [],
      };
      ai.chooser = () => ({ foodId: lentilsId, confidence: 'high' });

      const draft = await resolver.resolveOnce(userId, {
        phrase: 'some lentils',
        source: 'text',
      });

      expect(draft.items[0]?.quantity.grams).toBeNull();
      expect(draft.items[0]?.quantity.type).toBe('none_given');
      // No amount means no nutrient total. The sheet asks instead.
      expect(draft.items[0]?.nutrients).toBeNull();
    });

    it('offers a range for a personal unit it has never measured', async () => {
      ai.parseResult = {
        items: [
          {
            matchedText: 'a bowl of lentils',
            foodPhrase: 'lentils',
            quantityType: 'personal_unit',
            quantityValue: 1,
            quantityUnit: 'bowl',
          },
        ],
        unresolved: [],
      };
      ai.chooser = () => ({ foodId: lentilsId, confidence: 'high' });

      const draft = await resolver.resolveOnce(userId, {
        phrase: 'a bowl of lentils',
        source: 'text',
      });

      expect(draft.items[0]?.quantity.grams).toBeNull();
      // A range here is honesty; a range on "180 g chicken" would be noise.
      expect(draft.items[0]?.quantity.range).toEqual([150, 350]);
    });

    it('uses a learned personal unit and drops the range', async () => {
      await pg.db.insert(schema.userPortions).values({
        userId,
        unitLabel: 'bowl',
        foodId: null,
        grams: 210,
      });

      ai.parseResult = {
        items: [
          {
            matchedText: 'a bowl of lentils',
            foodPhrase: 'lentils',
            quantityType: 'personal_unit',
            quantityValue: 1,
            quantityUnit: 'bowl',
          },
        ],
        unresolved: [],
      };
      ai.chooser = () => ({ foodId: lentilsId, confidence: 'high' });

      const draft = await resolver.resolveOnce(userId, {
        phrase: 'a bowl of lentils',
        source: 'text',
      });

      expect(draft.items[0]?.quantity.grams).toBe(210);
      expect(draft.items[0]?.quantity.source).toBe('user_portion');
      expect(draft.items[0]?.quantity.range).toBeNull();
      // 116 kcal/100g x 210 g
      expect(draft.items[0]?.nutrients?.kcal).toBeCloseTo(243.6, 1);
    });

    it('prefills learned units into the parse call, not the system prompt', async () => {
      // The prompt is the cached prefix. Per-user context in it would key the
      // cache per user and roughly triple the bill, silently.
      await pg.db.insert(schema.userPortions).values({
        userId,
        unitLabel: 'bowl',
        foodId: null,
        grams: 210,
      });

      ai.parseResult = { items: [], unresolved: [] };
      await resolver.resolveOnce(userId, { phrase: 'a bowl', source: 'text' });

      expect(ai.lastKnownUnits).toEqual([{ label: 'bowl', grams: 210 }]);
    });

    it('converts stated masses in other units', async () => {
      ai.parseResult = {
        items: [
          {
            matchedText: '0.2 kg lentils',
            foodPhrase: 'lentils',
            quantityType: 'exact_mass',
            quantityValue: 0.2,
            quantityUnit: 'kg',
          },
        ],
        unresolved: [],
      };
      ai.chooser = () => ({ foodId: lentilsId, confidence: 'high' });

      const draft = await resolver.resolveOnce(userId, {
        phrase: '0.2 kg lentils',
        source: 'text',
      });
      expect(draft.items[0]?.quantity.grams).toBe(200);
    });
  });

  describe('multi-item phrases', () => {
    it('resolves every item from one batched candidate search', async () => {
      ai.parseResult = {
        items: [
          {
            matchedText: 'two rotis',
            foodPhrase: 'roti',
            quantityType: 'exact_mass',
            quantityValue: 90,
            quantityUnit: 'g',
          },
          {
            matchedText: 'dal',
            foodPhrase: 'lentils',
            quantityType: 'exact_mass',
            quantityValue: 200,
            quantityUnit: 'g',
          },
        ],
        unresolved: [],
      };
      ai.chooser = (item) =>
        item.phrase === 'roti'
          ? { foodId: rotiId, confidence: 'high' }
          : { foodId: lentilsId, confidence: 'high' };

      const draft = await resolver.resolveOnce(userId, {
        phrase: 'two rotis and dal',
        source: 'text',
      });

      expect(draft.items).toHaveLength(2);
      expect(draft.items.map((i) => i.food?.id)).toEqual([rotiId, lentilsId]);
      // One re-rank call for the whole meal, not one per item.
      expect(ai.rerankCalls).toBe(1);
    });
  });

  describe('the phrase cache', () => {
    beforeEach(() => {
      ai.parseResult = {
        items: [
          {
            matchedText: '180g chicken',
            foodPhrase: 'chicken',
            quantityType: 'exact_mass',
            quantityValue: 180,
            quantityUnit: 'g',
          },
        ],
        unresolved: [],
      };
      ai.chooser = () => ({ foodId: chickenId, confidence: 'high' });
    });

    it('serves a repeated phrase without calling the model', async () => {
      await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });
      expect(ai.parseCalls).toBe(1);

      const again = await resolver.resolveOnce(userId, {
        phrase: '180g chicken',
        source: 'text',
      });

      expect(ai.parseCalls).toBe(1);
      expect(again.cached).toBe(true);
      expect(again.items[0]?.nutrients?.kcal).toBe(216);
    });

    it('gives the cached draft a fresh id so two sheets never collide', async () => {
      const first = await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });
      const second = await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });
      expect(second.draftId).not.toBe(first.draftId);
    });

    it('normalizes trivial differences', async () => {
      await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });
      await resolver.resolveOnce(userId, { phrase: '  180G Chicken! ', source: 'text' });
      expect(ai.parseCalls).toBe(1);
    });

    it('does not share a cached answer between users', async () => {
      // The parse is prefilled with the user's own personal units, so two people
      // typing the same phrase must not share an answer.
      await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });
      await resolver.resolveOnce(await newUser(), { phrase: '180g chicken', source: 'text' });
      expect(ai.parseCalls).toBe(2);
    });

    it('records a zero-cost ai_run for a cache hit', async () => {
      // Otherwise the dashboards only see misses and the pipeline looks more
      // expensive per log than it is.
      await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });
      await resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' });

      const runs = await pg.db
        .select()
        .from(schema.aiRuns)
        .where(eq(schema.aiRuns.userId, userId));
      const hit = runs.find((r) => r.cached);
      expect(hit).toBeDefined();
      expect(Number(hit!.costUsd)).toBe(0);
    });
  });

  describe('failure paths', () => {
    it('is not an error when nothing parses', async () => {
      // "We couldn't read that" is a plain message and a fallback to search,
      // not a 500.
      ai.parseResult = { items: [], unresolved: ['blorptaculous'] };
      const draft = await resolver.resolveOnce(userId, {
        phrase: 'blorptaculous',
        source: 'text',
      });

      expect(draft.items).toEqual([]);
      expect(draft.unresolved).toEqual([{ text: 'blorptaculous' }]);
    });

    it('keeps resolved items when only some match', async () => {
      ai.parseResult = {
        items: [
          {
            matchedText: '200g lentils',
            foodPhrase: 'lentils',
            quantityType: 'exact_mass',
            quantityValue: 200,
            quantityUnit: 'g',
          },
          {
            matchedText: 'zzzznotafood',
            foodPhrase: 'zzzznotafood',
            quantityType: 'none_given',
            quantityValue: null,
            quantityUnit: null,
          },
        ],
        unresolved: [],
      };
      ai.chooser = () => ({ foodId: lentilsId, confidence: 'high' });

      const draft = await resolver.resolveOnce(userId, {
        phrase: '200g lentils and zzzznotafood',
        source: 'text',
      });

      expect(draft.items).toHaveLength(1);
      // The unmatched words become a scoped search row rather than vanishing.
      expect(draft.unresolved).toEqual([{ text: 'zzzznotafood' }]);
    });

    it('logs a miss with the exact words the user typed', async () => {
      // The curation queue: searchable and groupable, which is what makes
      // "which dishes next" a weekly query rather than a guess.
      ai.parseResult = {
        items: [
          {
            matchedText: 'zzzznotafood',
            foodPhrase: 'zzzznotafood',
            quantityType: 'none_given',
            quantityValue: null,
            quantityUnit: null,
          },
        ],
        unresolved: [],
      };

      await resolver.resolveOnce(userId, { phrase: 'zzzznotafood', source: 'text' });

      const misses = await pg.db
        .select()
        .from(schema.matchMisses)
        .where(eq(schema.matchMisses.userId, userId));
      expect(misses[0]?.itemText).toBe('zzzznotafood');
    });

    it('degrades to 503 when the model is unavailable', async () => {
      ai.failWith = new AiUnavailableError('upstream down');
      await expect(
        resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' }),
      ).rejects.toMatchObject({ problem: { status: 503 } });
    });

    it('degrades to 503 on a refusal rather than crashing', async () => {
      ai.failWith = new AiRefusedError('cyber');
      await expect(
        resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' }),
      ).rejects.toMatchObject({ problem: { status: 503 } });
    });

    it('refunds the quota unit when the call fails', async () => {
      // A failed resolve should not cost the user one of their daily logs.
      ai.failWith = new AiUnavailableError('upstream down');
      await expect(
        resolver.resolveOnce(userId, { phrase: '180g chicken', source: 'text' }),
      ).rejects.toBeDefined();

      const used = await redis.get(
        `quota:resolve:${new Date().toISOString().slice(0, 10)}:${userId}`,
      );
      expect(Number(used ?? 0)).toBe(0);
    });

    it('does not cache a partially resolved draft', async () => {
      // Caching a bad result would freeze it for 24 hours.
      ai.parseResult = {
        items: [
          {
            matchedText: 'zzzznotafood',
            foodPhrase: 'zzzznotafood',
            quantityType: 'none_given',
            quantityValue: null,
            quantityUnit: null,
          },
        ],
        unresolved: [],
      };
      await resolver.resolveOnce(userId, { phrase: 'zzzznotafood', source: 'text' });
      await resolver.resolveOnce(userId, { phrase: 'zzzznotafood', source: 'text' });
      expect(ai.parseCalls).toBe(2);
    });
  });

  describe('low confidence', () => {
    it('flags the row and logs it for curation', async () => {
      ai.parseResult = {
        items: [
          {
            matchedText: 'chicken',
            foodPhrase: 'chicken',
            quantityType: 'exact_mass',
            quantityValue: 100,
            quantityUnit: 'g',
          },
        ],
        unresolved: [],
      };
      ai.chooser = (item) => ({ foodId: item.candidates[0]!.id, confidence: 'low' });

      const draft = await resolver.resolveOnce(userId, {
        phrase: 'chicken',
        source: 'text',
      });

      expect(draft.items[0]?.confidence).toBe('low');
      const misses = await pg.db
        .select()
        .from(schema.matchMisses)
        .where(eq(schema.matchMisses.userId, userId));
      expect(misses).toHaveLength(1);
    });
  });

  describe('draft to commit', () => {
    it('a draft can be committed and freezes the same numbers', async () => {
      ai.parseResult = {
        items: [
          {
            matchedText: '180g chicken',
            foodPhrase: 'chicken',
            quantityType: 'exact_mass',
            quantityValue: 180,
            quantityUnit: 'g',
          },
        ],
        unresolved: [],
      };
      ai.chooser = () => ({ foodId: chickenId, confidence: 'high' });

      const draft = await resolver.resolveOnce(userId, {
        phrase: '180g chicken',
        source: 'text',
      });

      const { entry } = await logs.commit(userId, {
        clientId: randomUUID(),
        loggedAt: '2026-08-26T12:00:00.000Z',
        meal: 'lunch',
        source: 'text',
        phrase: draft.phrase,
        draftId: draft.draftId,
        items: draft.items.map((item) => ({
          foodId: item.food!.id,
          grams: item.quantity.grams!,
          quantityType: item.quantity.type,
          quantitySource: item.quantity.source,
          learnedUnitLabel: null,
        })),
      });

      // The server recomputes at commit; the draft's numbers were never trusted.
      expect(entry.items[0]?.nutrients.kcal).toBe(216);
      expect(entry.phrase).toBe('180g chicken');
      expect(entry.source).toBe('text');
    });
  });
});

/**
 * Regression tests for a gap the first live call exposed: the code carried a
 * comment saying count and standard_measure were "filled in below", and nothing
 * below filled them in. "Two rotis" resolved to a food and then produced no
 * grams and no nutrients at all.
 */
describe('resolveAgainstFood', () => {
  const parsed = (
    quantityType: 'count' | 'standard_measure' | 'exact_mass',
    quantityValue: number | null,
    quantityUnit: string | null,
  ) => ({
    matchedText: 'x',
    foodPhrase: 'x',
    quantityType,
    quantityValue,
    quantityUnit,
  });

  const unresolvedQty = (type: 'count' | 'standard_measure') =>
    ({ type, raw: 'x', grams: null, source: 'unknown', range: null }) as const;

  const rotiPortions = [{ label: '1 piece', grams: 45, isDefault: true }];
  const applePortions = [
    { label: '1 medium (approx 3 per lb)', grams: 182, isDefault: true },
    { label: '1 cup, quartered or chopped', grams: 125, isDefault: false },
  ];

  it('multiplies a count by the default portion', () => {
    // Two rotis is two of whatever one roti is: 2 x 45 g.
    const result = resolveAgainstFood(
      unresolvedQty('count'),
      parsed('count', 2, 'roti'),
      rotiPortions,
    );
    expect(result.grams).toBe(90);
    expect(result.source).toBe('food_portion');
  });

  it('matches a standard measure against the portion label', () => {
    const result = resolveAgainstFood(
      unresolvedQty('standard_measure'),
      parsed('standard_measure', 1, 'cup'),
      applePortions,
    );
    expect(result.grams).toBe(125);
  });

  it('matches a plural label against a singular unit', () => {
    const result = resolveAgainstFood(
      unresolvedQty('count'),
      parsed('count', 2, 'slice'),
      [{ label: '2 slices', grams: 60, isDefault: true }],
      );
    expect(result.grams).toBe(120);
  });

  it('does not fall back to a default portion for a standard measure', () => {
    // "A cup of rice" resolved via a portion labelled "1 medium apple" would be
    // nonsense. Better to ask.
    const result = resolveAgainstFood(
      unresolvedQty('standard_measure'),
      parsed('standard_measure', 1, 'cup'),
      rotiPortions,
    );
    expect(result.grams).toBeNull();
  });

  it('leaves grams null when the food has no portions', () => {
    const result = resolveAgainstFood(
      unresolvedQty('count'),
      parsed('count', 2, 'roti'),
      [],
    );
    expect(result.grams).toBeNull();
  });

  it('never overwrites an amount that is already known', () => {
    const stated = {
      type: 'exact_mass',
      raw: '180 g',
      grams: 180,
      source: 'stated',
      range: null,
    } as const;
    const result = resolveAgainstFood(stated, parsed('exact_mass', 180, 'g'), rotiPortions);
    expect(result).toEqual(stated);
  });

  it('defaults a missing count to one', () => {
    const result = resolveAgainstFood(
      unresolvedQty('count'),
      parsed('count', null, 'roti'),
      rotiPortions,
    );
    expect(result.grams).toBe(45);
  });
});

describe('resolver robustness', () => {
  /**
   * Observed live: gpt-4o-mini returned one pick for two items and the second
   * item silently became unresolved, even though the corpus had it and the
   * search returned candidates. Never silently drop words that look like food.
   */
  it('keeps an item the re-rank forgot, at low confidence', async () => {
    const pg2 = await startTestPostgres();
    try {
      await ingestUsda(pg2.db, FIXTURES);
      const redis2 = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        db: 14,
        maxRetriesPerRequest: null,
      });
      await redis2.flushdb();

      const [user] = await pg2.db
        .insert(schema.users)
        .values({ email: `omit-${randomUUID()}@example.com` })
        .returning({ id: schema.users.id });

      const partialAi = new FakeAi();
      partialAi.parseResult = {
        items: [
          {
            matchedText: 'a cup of rice',
            foodPhrase: 'rice',
            quantityType: 'standard_measure',
            quantityValue: 1,
            quantityUnit: 'cup',
          },
          {
            matchedText: 'an apple',
            foodPhrase: 'apple',
            quantityType: 'count',
            quantityValue: 1,
            quantityUnit: 'apple',
          },
        ],
        unresolved: [],
      };
      // Reproduce the real failure: pick only for item 0.
      (partialAi as unknown as { rerank: unknown }).rerank = async (
        items: RerankItem[],
      ) => ({
        value: {
          picks: [
            {
              itemIndex: items[0]!.index,
              foodId: items[0]!.candidates[0]!.id,
              confidence: 'high' as const,
            },
          ],
        },
        usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
        latencyMs: 1,
        stopReason: 'stop',
        model: 'claude-opus-5',
        promptVersion: 'partial',
        raw: {},
      });

      const config = {
        get: (key: string) =>
          ({ RESOLVE_DAILY_QUOTA: 50, RESOLVE_USER_DAILY_SPEND_USD: 1 })[key],
      } as unknown as ConfigService<never, true>;

      const svc = new ResolverService(
        pg2.db,
        partialAi,
        new AiRunsService(pg2.db),
        new FoodsService(pg2.db),
        new PortionPrefillService(pg2.db),
        new DraftStoreService(redis2),
        new QuotaService(pg2.db, redis2, config),
      );

      const draft = await svc.resolveOnce(user!.id, {
        phrase: 'a cup of rice and an apple',
        source: 'text',
      });

      // Both survive. The forgotten one is flagged so the sheet surfaces it.
      expect(draft.items).toHaveLength(2);
      expect(draft.items[1]?.confidence).toBe('low');
      expect(draft.items[1]?.food).not.toBeNull();
      expect(draft.unresolved).toEqual([]);

      await redis2.flushdb();
      await redis2.quit();
    } finally {
      await pg2.stop();
    }
  });
});

describe('personal units against a food that defines them', () => {
  const parsed = (unit: string, value: number | null) => ({
    matchedText: 'x',
    foodPhrase: 'x',
    quantityType: 'personal_unit' as const,
    quantityValue: value,
    quantityUnit: unit,
  });
  const unresolved = {
    type: 'personal_unit' as const,
    raw: '1 plate',
    grams: null,
    source: 'unknown' as const,
    range: [200, 450] as [number, number],
  };
  const biryani = [
    { label: '1 plate', grams: 350, isDefault: true },
    { label: '1 cup', grams: 200, isDefault: false },
  ];

  it('uses the portion the food defines rather than asking', () => {
    // A curated row shipping "1 plate = 350 g" is corpus data, not a guess.
    const r = resolveAgainstFood(unresolved, parsed('plate', 1), biryani);
    expect(r.grams).toBe(350);
    expect(r.source).toBe('food_portion');
  });

  it('drops the range once there is a real number behind the chip', () => {
    const r = resolveAgainstFood(unresolved, parsed('plate', 1), biryani);
    expect(r.range).toBeNull();
  });

  it('multiplies by the count', () => {
    expect(resolveAgainstFood(unresolved, parsed('cup', 2), biryani).grams).toBe(400);
  });

  it('still asks when the food defines no such vessel', () => {
    // "A bowl" of something with no bowl-sized portion is exactly the case that
    // must be asked rather than invented.
    const r = resolveAgainstFood(unresolved, parsed('bowl', 1), biryani);
    expect(r.grams).toBeNull();
    expect(r.range).toEqual([200, 450]);
  });

  it('never overrides a unit the user has already taught', () => {
    const learned = {
      type: 'personal_unit' as const,
      raw: '1 plate',
      grams: 300,
      source: 'user_portion' as const,
      range: null,
    };
    expect(resolveAgainstFood(learned, parsed('plate', 1), biryani)).toEqual(learned);
  });
});
