import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { PROMPTS } from '@nutricheck/prompts';
import type { MealFacts } from '@nutricheck/contracts';
import type { AppConfig } from '../../config/config.schema';
import {
  AiMalformedError,
  AiRefusedError,
  AiService,
  AiUnavailableError,
  type AiCallResult,
  type RerankItem,
} from './ai.service';
import { InsightResult, ParseResult, rerankSchemaFor, type RerankResult } from './ai.schemas';
import { factsToUserTurn } from './insight-input';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import type { TokenUsage } from './cost';

/**
 * Any provider that speaks the OpenAI chat-completions wire format.
 *
 * That is a large share of the market — OpenAI itself, Groq, Together,
 * OpenRouter, DeepSeek, Fireworks, vLLM and Ollama all expose it — so a single
 * implementation plus a configurable base URL covers "can we use any model
 * key?" for most answers to that question.
 *
 * The pipeline is unchanged. The two guarantees that matter are properties of
 * the SCHEMAS, not of the vendor: the parse schema has no nutrient field, and
 * the re-rank schema is an enum of real row ids. Those hold whoever answers.
 */
@Injectable()
export class OpenAiCompatibleService extends AiService {
  private readonly logger = new Logger(OpenAiCompatibleService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;
  private readonly breaker: CircuitBreaker;
  private readonly supportsStrictSchema: boolean;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    super();

    const apiKey = this.config.get('AI_API_KEY', { infer: true });
    const baseURL = this.config.get('AI_BASE_URL', { infer: true });
    this.model = this.config.get('AI_MODEL', { infer: true });
    this.supportsStrictSchema = this.config.get('AI_STRICT_SCHEMA', { infer: true });

    this.client = apiKey
      ? new OpenAI({
          apiKey,
          // Unset for OpenAI itself; set for anything else that speaks the
          // same protocol.
          ...(baseURL ? { baseURL } : {}),
          timeout: this.config.get('ANTHROPIC_TIMEOUT_MS', { infer: true }),
          maxRetries: 1,
        })
      : null;

    if (!this.client) {
      this.logger.warn('AI_API_KEY is not set — /v1/resolve is disabled');
    } else {
      this.logger.log(
        { model: this.model, baseURL: baseURL ?? 'api.openai.com' },
        'AI provider: openai-compatible',
      );
    }

    this.breaker = new CircuitBreaker('openai-compatible', {
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
    // Per-user context in the user turn, never the system prompt. Providers
    // with automatic prefix caching key on the prefix exactly as Anthropic's
    // explicit breakpoints do, so the rule is identical here.
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
      ParseResult,
      'parse_result',
    );
  }

  async rerank(items: RerankItem[]): Promise<AiCallResult<RerankResult>> {
    const candidateIds = items.flatMap((item) => item.candidates.map((c) => c.id));

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
      rerankSchemaFor(candidateIds),
      'rerank_result',
    ) as Promise<AiCallResult<RerankResult>>;
  }

  async insight(facts: MealFacts): Promise<AiCallResult<InsightResult>> {
    return this.call(
      'insight',
      PROMPTS.insight.system,
      PROMPTS.insight.version,
      factsToUserTurn(facts),
      InsightResult,
      'meal_insight',
    );
  }

  private async call<T>(
    step: string,
    system: string,
    promptVersion: string,
    userTurn: string,
    schema: ZodTypeAny,
    schemaName: string,
  ): Promise<AiCallResult<T>> {
    if (!this.client) throw new AiUnavailableError('no API key configured');

    const started = Date.now();
    const jsonSchema = toJsonSchema(schema);

    try {
      return await this.breaker.run(async () => {
        const response = await this.client!.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userTurn },
          ],
          max_completion_tokens: 4096,
          // json_schema with strict:true is what makes the candidate-id enum a
          // guarantee rather than a request. Providers that do not implement
          // strict mode fall back to plain json_object, and the Zod parse below
          // becomes the only thing enforcing the shape — which is why the
          // fallback is opt-in rather than silent.
          response_format: this.supportsStrictSchema
            ? {
                type: 'json_schema',
                json_schema: {
                  name: schemaName,
                  strict: true,
                  schema: jsonSchema as Record<string, unknown>,
                },
              }
            : { type: 'json_object' },
        });

        const choice = response.choices[0];

        // Content filters and refusals surface differently per provider: a
        // `refusal` field on OpenAI, a finish_reason elsewhere.
        const refusal = (choice?.message as { refusal?: string | null })?.refusal;
        if (refusal) throw new AiRefusedError(refusal);
        if (choice?.finish_reason === 'content_filter') {
          throw new AiRefusedError('content_filter');
        }

        const content = choice?.message?.content;
        if (!content) {
          throw new AiMalformedError(
            `empty response (finish_reason=${choice?.finish_reason})`,
          );
        }

        // Parsed with Zod regardless of strict mode. A provider that claims
        // schema support and does not honour it must fail here, loudly, rather
        // than feeding a malformed item into the arithmetic.
        let value: T;
        try {
          value = schema.parse(JSON.parse(content)) as T;
        } catch (error) {
          throw new AiMalformedError(
            `response did not match the schema: ${(error as Error).message}`,
          );
        }

        return {
          value,
          usage: usageOf(response.usage),
          latencyMs: Date.now() - started,
          stopReason: choice?.finish_reason ?? null,
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
      if (error instanceof OpenAI.RateLimitError) {
        this.logger.warn({ step }, 'rate limited by upstream');
        throw new AiUnavailableError('rate limited');
      }
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new AiUnavailableError('upstream timed out');
      }
      if (error instanceof OpenAI.APIError) {
        this.logger.error({ step, status: error.status }, 'upstream API error');
        throw new AiUnavailableError(`upstream error ${error.status}`);
      }
      throw error;
    }
  }

  resetBreaker(): void {
    this.breaker.reset();
  }
}

/** See zod-dto.ts: the generic parameter blows the instantiation-depth limit. */
const convert = zodToJsonSchema as unknown as (
  schema: ZodTypeAny,
  options?: unknown,
) => Record<string, unknown>;

function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const json = convert(schema, { $refStrategy: 'none', target: 'openApi3' });
  // OpenAI strict mode requires additionalProperties:false on every object and
  // every property listed in `required`. Omitting either is a 400, not a
  // downgrade, so normalize rather than hope.
  return tighten(json);
}

function tighten(node: Record<string, unknown>): Record<string, unknown> {
  if (node.type === 'object') {
    const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
    node.additionalProperties = false;
    node.required = Object.keys(properties);
    for (const child of Object.values(properties)) tighten(child);
  }
  if (node.type === 'array' && node.items) {
    tighten(node.items as Record<string, unknown>);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = node[key] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(members)) members.forEach(tighten);
  }
  return node;
}

function usageOf(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, number | undefined>;
  const cached = details.cached_tokens ?? 0;
  const prompt = (u.prompt_tokens as number | undefined) ?? 0;

  return {
    // OpenAI reports cached tokens INSIDE prompt_tokens, where Anthropic reports
    // them separately. Subtracting keeps the cost arithmetic identical across
    // providers instead of double-counting the cached prefix.
    inputTokens: Math.max(prompt - cached, 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: (u.completion_tokens as number | undefined) ?? 0,
  };
}
