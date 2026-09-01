import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Database } from '@nutricheck/database';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import type { AiCallResult } from './ai.service';
import { cacheHitRatio, costUsd, type TokenUsage } from './cost';

/**
 * Mirrors the ai_step enum. Widened past parse and rerank when the meal path
 * arrived. Every step here now records: `identify` is the one that does not,
 * because nothing calls it yet — see the unreachable `identify()` path.
 *
 * `ideas` is the one to watch. It is the first step that fires because a TAB
 * WAS OPENED rather than because somebody asked a question, so its volume is
 * bounded by navigation rather than by intent — which is exactly the shape of
 * spend that runs away without anyone noticing. It records like the rest, and
 * that is what keeps RESOLVE_USER_DAILY_SPEND_USD a real ceiling for it.
 */
export type AiStep =
  | 'parse'
  | 'rerank'
  | 'insight'
  | 'identify'
  | 'meal'
  | 'targets'
  | 'ideas'
  | 'chat'
  | 'review';

export interface RecordRunInput {
  userId: string;
  step: AiStep;
  inputHash: string;
  cached: boolean;
  model: string;
  promptVersion: string;
  usage: TokenUsage;
  latencyMs: number;
  stopReason: string | null;
  response: unknown;
}

/**
 * One row per model call.
 *
 * The spine of cost attribution, prompt-regression analysis and the eval set.
 * It answers questions nothing else can: which prompt version regressed, what a
 * heavy user costs, and why one specific log came out wrong — because the
 * stored phrase is the reproducible input, any bad log can be replayed exactly.
 */
@Injectable()
export class AiRunsService {
  private readonly logger = new Logger(AiRunsService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(input: RecordRunInput): Promise<string> {
    const cost = costUsd(input.model, input.usage);

    // The cache-hit ratio is the single most useful number on the dashboard: if
    // it trends toward zero across repeated requests, a silent invalidator is
    // at work. Logged per call so the alert has something to aggregate.
    const ratio = cacheHitRatio(input.usage);
    if (!input.cached && ratio < 0.3 && input.usage.inputTokens > 500) {
      this.logger.warn(
        { step: input.step, ratio: Number(ratio.toFixed(2)), promptVersion: input.promptVersion },
        'low prompt-cache hit ratio — check for a per-request value in the cached prefix',
      );
    }

    const [row] = await this.db
      .insert(schema.aiRuns)
      .values({
        userId: input.userId,
        promptVersion: input.promptVersion,
        model: input.model,
        step: input.step,
        inputHash: input.inputHash,
        cached: input.cached,
        inputTokens: input.usage.inputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        outputTokens: input.usage.outputTokens,
        costUsd: cost,
        latencyMs: input.latencyMs,
        stopReason: input.stopReason,
        response: input.response as never,
      })
      .returning({ id: schema.aiRuns.id });

    return row!.id;
  }

  /** Convenience for the common case of persisting a completed call. */
  async recordCall(
    userId: string,
    step: AiStep,
    inputHash: string,
    result: AiCallResult<unknown>,
  ): Promise<string> {
    return this.record({
      userId,
      step,
      inputHash,
      cached: false,
      model: result.model,
      promptVersion: result.promptVersion,
      usage: result.usage,
      latencyMs: result.latencyMs,
      stopReason: result.stopReason,
      response: result.raw,
    });
  }

  /**
   * A cache hit still gets a row, with zero tokens and zero cost.
   *
   * Without it the dashboards would show only the calls that missed, making the
   * pipeline look more expensive per log than it is and making eval sampling
   * unrepresentative of real traffic.
   */
  async recordCacheHit(
    userId: string,
    inputHash: string,
    model: string,
    promptVersion: string,
  ): Promise<string> {
    return this.record({
      userId,
      step: 'parse',
      inputHash,
      cached: true,
      model,
      promptVersion,
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      stopReason: null,
      response: null,
    });
  }
}
