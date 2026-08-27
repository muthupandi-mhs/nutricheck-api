import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { PROMPTS } from '@nutricheck/prompts';
import type { GoalPreview, MealFacts, UserProfile } from '@nutricheck/contracts';
import type { AppConfig } from '../../config/config.schema';
import {
  AiMalformedError,
  AiRefusedError,
  AiService,
  AiUnavailableError,
  type AiCallResult,
  type RerankItem,
} from './ai.service';
import {
  AiMealResult,
  IdentifyResult,
  InsightResult,
  TargetsResult,
  ParseResult,
  rerankSchemaFor,
  type RerankResult,
} from './ai.schemas';
import { factsToUserTurn } from './insight-input';
import { profileToUserTurn } from './targets-input';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import type { TokenUsage } from './cost';

/**
 * The only file in the codebase that imports @anthropic-ai/sdk.
 *
 * Enforced by convention and by the module boundary: nothing outside
 * modules/ai knows which model is in use, what it costs, or that Anthropic is
 * the vendor. Swapping the provider is a change to this file.
 */
@Injectable()
export class AnthropicService extends AiService {
  private readonly logger = new Logger(AnthropicService.name);
  private readonly client: Anthropic | null;
  private readonly model: string;
  private readonly breaker: CircuitBreaker;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    super();

    const apiKey = this.config.get('ANTHROPIC_API_KEY', { infer: true });
    this.model = this.config.get('ANTHROPIC_MODEL', { infer: true });

    // No key is a supported state, not a crash. The API boots and every route
    // except the resolver works — which is exactly the degradation the flows
    // are designed around.
    this.client = apiKey
      ? new Anthropic({
          apiKey,
          timeout: this.config.get('ANTHROPIC_TIMEOUT_MS', { infer: true }),
          // One retry. The route has an 8s budget; a third attempt is worse for
          // the user than failing over to search.
          maxRetries: 1,
        })
      : null;

    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY is not set — /v1/resolve is disabled');
    }

    this.breaker = new CircuitBreaker('anthropic', {
      threshold: 0.5,
      windowMs: 30_000,
      resetMs: 30_000,
      minimumCalls: 5,
    });
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  async parse(
    phrase: string,
    knownUnits: ReadonlyArray<{ label: string; grams: number }>,
  ): Promise<AiCallResult<ParseResult>> {
    // Per-user context goes in the USER turn, after the cached prefix. Putting
    // it in the system prompt would key the cache per user and roughly triple
    // the bill, with no error and no failing test to tell you.
    const userTurn = knownUnits.length
      ? `Known personal units for this user:\n${knownUnits
          .map((u) => `- their ${u.label} = ${u.grams} g`)
          .join('\n')}\n\nPhrase: ${phrase}`
      : `Phrase: ${phrase}`;

    return this.call(
      'parse',
      PROMPTS.parse.system,
      PROMPTS.parse.version,
      userTurn,
      betaZodOutputFormat(ParseResult),
    );
  }

  async rerank(items: RerankItem[]): Promise<AiCallResult<RerankResult>> {
    // The enum is built from the ids Postgres just returned, so an off-list
    // answer is unrepresentable rather than merely discouraged.
    const candidateIds = items.flatMap((item) => item.candidates.map((c) => c.id));

    // Candidate rows are the largest UNCACHED input in the pipeline. Id, short
    // name, kcal — no descriptions, no brand chains, no portion tables.
    const userTurn = items
      .map((item) => {
        const lines = item.candidates
          .map((c) => `  ${c.id} ${c.name} (${Math.round(c.kcalPer100g)} kcal/100g)`)
          .join('\n');
        return `Item ${item.index}: "${item.phrase}"\n${lines}`;
      })
      .join('\n\n');

    return this.call(
      'rerank',
      PROMPTS.rerank.system,
      PROMPTS.rerank.version,
      userTurn,
      betaZodOutputFormat(rerankSchemaFor(candidateIds)),
    ) as Promise<AiCallResult<RerankResult>>;
  }

  async insight(facts: MealFacts): Promise<AiCallResult<InsightResult>> {
    return this.call(
      'insight',
      PROMPTS.insight.system,
      PROMPTS.insight.version,
      factsToUserTurn(facts),
      betaZodOutputFormat(InsightResult),
    );
  }

  async suggestTargets(
    profile: UserProfile,
    derived: GoalPreview,
  ): Promise<AiCallResult<TargetsResult>> {
    return this.call(
      'targets',
      PROMPTS.targets.system,
      PROMPTS.targets.version,
      profileToUserTurn(profile, derived),
      betaZodOutputFormat(TargetsResult),
    );
  }

  async interpretMeal(phrase: string): Promise<AiCallResult<AiMealResult>> {
    return this.call(
      'meal',
      PROMPTS.meal.system,
      PROMPTS.meal.version,
      phrase,
      betaZodOutputFormat(AiMealResult),
    );
  }

  async identify(phrase: string): Promise<AiCallResult<IdentifyResult>> {
    // The bare phrase, with no candidate list and no surrounding items. This
    // step runs precisely because search found nothing, so there is nothing
    // useful to show the model -- and offering it context it cannot act on
    // invites it to pick from that context instead of translating.
    return this.call(
      'identify',
      PROMPTS.identify.system,
      PROMPTS.identify.version,
      phrase,
      betaZodOutputFormat(IdentifyResult),
    );
  }

  private async call<T>(
    step: string,
    system: string,
    promptVersion: string,
    userTurn: string,
    format: unknown,
  ): Promise<AiCallResult<T>> {
    if (!this.client) throw new AiUnavailableError('no API key configured');

    const started = Date.now();

    try {
      return await this.breaker.run(async () => {
        const response = await this.client!.beta.messages.parse({
          model: this.model,
          max_tokens: 4096,
          // `thinking` is deliberately omitted. On Claude Opus 5 omitting it
          // runs adaptive thinking, which is what we want; the installed SDK
          // (0.70.1) types `thinking` as enabled-with-a-token-budget only, so
          // stating it explicitly would mean asking for the deprecated form.
          //
          // `effort` is likewise absent: the design calls for medium on the
          // parse and low on the re-rank, and this SDK version has no parameter
          // for it. Both calls therefore run at the default. Revisit when the
          // SDK exposes output_config -- see the note in AiModule.
          output_format: format as never,
          system: [
            {
              type: 'text',
              text: system,
              // The breakpoint. Everything before it caches; nothing variable
              // may appear before this point.
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: userTurn }],
        });

        // A safety decline arrives as HTTP 200 with stop_reason "refusal", so
        // stop_reason must be checked before content is read.
        if (response.stop_reason === 'refusal') {
          throw new AiRefusedError(
            (response as { stop_details?: { category?: string } }).stop_details
              ?.category ?? null,
          );
        }

        const parsed = (response as { parsed?: T | null }).parsed;
        if (!parsed) {
          throw new AiMalformedError(
            `structured output missing (stop_reason=${response.stop_reason})`,
          );
        }

        return {
          value: parsed,
          usage: usageOf(response.usage),
          latencyMs: Date.now() - started,
          stopReason: response.stop_reason ?? null,
          model: this.model,
          promptVersion,
          raw: response,
        };
      });
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new AiUnavailableError('upstream circuit is open');
      }
      if (
        error instanceof AiRefusedError ||
        error instanceof AiMalformedError ||
        error instanceof AiUnavailableError
      ) {
        throw error;
      }

      // Typed SDK errors, most specific first. A 429 or 5xx is retryable and a
      // 400 is not, and the resolver treats them differently.
      if (error instanceof Anthropic.RateLimitError) {
        this.logger.warn({ step }, 'rate limited by upstream');
        throw new AiUnavailableError('rate limited');
      }
      if (error instanceof Anthropic.APIConnectionTimeoutError) {
        throw new AiUnavailableError('upstream timed out');
      }
      if (error instanceof Anthropic.APIError) {
        this.logger.error({ step, status: error.status }, 'upstream API error');
        throw new AiUnavailableError(`upstream error ${error.status}`);
      }
      throw error;
    }
  }

  /** Test seam, so a breaker tripped by one spec cannot leak into the next. */
  resetBreaker(): void {
    this.breaker.reset();
  }
}

function usageOf(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as Record<string, number | undefined>;
  return {
    inputTokens: u.input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };
}
