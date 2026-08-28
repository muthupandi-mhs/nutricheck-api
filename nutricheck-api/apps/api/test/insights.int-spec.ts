import type { CommitLogEntry, MealFacts } from '@nutricheck/contracts';
import { eq, schema } from '@nutricheck/database';
import { ingestUsda } from '@nutricheck/ingest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Redis from 'ioredis';
import { AiRunsService } from '../src/modules/ai/ai-runs.service';
import { AiService, type AiCallResult, type RerankItem } from '../src/modules/ai/ai.service';
import type {
  AiMealResult,
  IdeasResult,
  IdentifyResult,
  InsightResult,
  ParseResult,
  RerankResult,
  TargetsResult,
} from '../src/modules/ai/ai.schemas';
import { GoalsService } from '../src/modules/goals/goals.service';
import { InsightsService } from '../src/modules/insights/insights.service';
import { LogsService } from '../src/modules/logs/logs.service';
import { startTestPostgres, type TestDatabase } from './postgres';

const FIXTURES = join(__dirname, '..', '..', '..', 'tools', 'ingest', 'fixtures');

/**
 * Only `insight` is real here — the note path is the whole subject, and a fake
 * that answered the other steps would let a test pass against the wrong call.
 */
class FakeAi extends AiService {
  insightCalls = 0;
  text = 'You are 400 kcal short of the day.';
  failWith: Error | null = null;

  get isConfigured(): boolean {
    return true;
  }

  async insight(_facts: MealFacts): Promise<AiCallResult<InsightResult>> {
    this.insightCalls += 1;
    if (this.failWith) throw this.failWith;
    return {
      value: { text: this.text },
      usage: {
        inputTokens: 80,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        outputTokens: 40,
      },
      latencyMs: 7,
      stopReason: 'end_turn',
      model: 'claude-opus-5',
      promptVersion: 'insight-v1',
      raw: { fake: true },
    };
  }

  /**
   * Neither suite reaches this. It is here because AiService is abstract and
   * grew the member, and stubbing it rather than softening the base class keeps
   * the compiler as the thing that notices the contract changed.
   */
  async suggestTargets(): Promise<AiCallResult<TargetsResult>> {
    return {
      value: { kcal: 2000, proteinG: 120, fiberG: 28, reasoning: 'a fake suggestion' },
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      stopReason: 'end_turn',
      model: 'claude-opus-5',
      promptVersion: 'targets-v1',
      raw: { fake: true },
    };
  }

  async parse(): Promise<AiCallResult<ParseResult>> {
    throw new Error('the note path does not parse');
  }
  async rerank(_items: RerankItem[]): Promise<AiCallResult<RerankResult>> {
    throw new Error('the note path does not re-rank');
  }
  /** Same reason as `suggestTargets`: unreached, stubbed so the compiler stays the guard. */
  async suggestFoods(): Promise<AiCallResult<IdeasResult>> {
    return {
      value: { note: 'a fake note', ideas: [] },
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      stopReason: 'end_turn',
      model: 'claude-opus-5',
      promptVersion: 'ideas-v1',
      raw: { fake: true },
    };
  }
  async identify(): Promise<AiCallResult<IdentifyResult>> {
    throw new Error('the note path does not identify');
  }
  async interpretMeal(): Promise<AiCallResult<AiMealResult>> {
    throw new Error('the note path does not interpret a meal');
  }
}

describe('insights', () => {
  let pg: TestDatabase;
  let redis: Redis;
  let ai: FakeAi;
  let aiRuns: AiRunsService;
  let insights: InsightsService;
  let logs: LogsService;
  let userId: string;
  let lentilsId: string;

  const DATE = '2026-08-26';

  beforeAll(async () => {
    pg = await startTestPostgres();
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      db: 15, // a scratch database, so a test run cannot evict real cache keys
      maxRetriesPerRequest: null,
    });

    await ingestUsda(pg.db, FIXTURES);

    logs = new LogsService(pg.db, new GoalsService(pg.db));
    ai = new FakeAi();
    aiRuns = new AiRunsService(pg.db);
    insights = new InsightsService(logs, ai, aiRuns, redis);

    lentilsId = await foodIdBySourceId('169705');
  });

  afterAll(async () => {
    await redis?.flushdb();
    await redis?.quit();
    await pg?.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
    ai.insightCalls = 0;
    ai.failWith = null;
    // A fresh user per test: the note is cached against the meal's contents and
    // the runs are read back by user id, so sharing one would couple the tests.
    userId = await newUser();
    await logs.commit(userId, entry());
  });

  async function newUser(): Promise<string> {
    const [user] = await pg.db
      .insert(schema.users)
      .values({ email: `insight-${randomUUID()}@example.com` })
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

  function entry(): CommitLogEntry {
    return {
      clientId: randomUUID(),
      loggedAt: `${DATE}T03:30:00.000Z`, // 09:00 in Asia/Kolkata — breakfast
      meal: 'breakfast',
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
    };
  }

  const note = (): Promise<{ text: string; cached: boolean }> =>
    insights.mealInsight(userId, DATE, 'breakfast', 'Asia/Kolkata');

  const runsFor = async (): Promise<Array<typeof schema.aiRuns.$inferSelect>> =>
    pg.db.select().from(schema.aiRuns).where(eq(schema.aiRuns.userId, userId));

  it('records the call, so the note reaches cost attribution', async () => {
    const result = await note();
    expect(result.text).toBe(ai.text);

    const runs = await runsFor();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.step).toBe('insight');
    expect(runs[0]!.promptVersion).toBe('insight-v1');
    expect(runs[0]!.cacheReadTokens).toBe(900);
    // The point of the row: without a cost, spend never reaches the daily cap.
    expect(Number(runs[0]!.costUsd)).toBeGreaterThan(0);
  });

  it('does not bill a second time for a note served from cache', async () => {
    await note();
    const second = await note();

    expect(second.cached).toBe(true);
    expect(ai.insightCalls).toBe(1);
    // A row per model call, not per request. Charging the cache would make a
    // user who opens the screen all afternoon look like a user who cost money.
    expect(await runsFor()).toHaveLength(1);
  });

  it('keeps the note when the run cannot be recorded', async () => {
    jest
      .spyOn(aiRuns, 'recordCall')
      .mockRejectedValueOnce(new Error('ai_runs is unreachable'));

    // The call is already paid for by this point. Losing the accounting row is
    // a problem for the dashboard; throwing away the sentence is a problem for
    // the person waiting on it.
    await expect(note()).resolves.toMatchObject({ text: ai.text, cached: false });
  });

  it('writes no row when there is nothing in the slot to write about', async () => {
    const empty = await insights.mealInsight(userId, DATE, 'dinner', 'Asia/Kolkata');

    expect(empty.text).toBe('');
    expect(ai.insightCalls).toBe(0);
    expect(await runsFor()).toEqual([]);
  });
});
