import { z } from 'zod';

/**
 * Env vars are strings, and `z.coerce.boolean()` is the wrong tool for them:
 * it applies JS truthiness, so "false" coerces to TRUE. Every flag written that
 * way is permanently on, silently.
 */
const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const durationString = z
  .string()
  .regex(/^\d+[smhd]$/, "expected a duration like '15m' or '30d'");

/**
 * The complete environment contract. The process refuses to start if any of
 * this is missing or malformed — a bad deploy fails at boot with a readable
 * message instead of at 3am with a null dereference.
 *
 * Nothing outside this directory reads process.env.
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ACCESS_TTL: durationString.default('15m'),
  JWT_REFRESH_TTL: durationString.default('30d'),

  /**
   * Which vendor answers. `anthropic` is the locked decision in PLAN.md §3;
   * `openai-compatible` covers anything speaking that wire format — OpenAI,
   * Groq, Together, OpenRouter, DeepSeek, Fireworks, vLLM, Ollama — via
   * AI_BASE_URL.
   */
  AI_PROVIDER: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),

  /**
   * Optional until M2. The API boots without a key; only the resolver route is
   * disabled, which is exactly the degradation USER-FLOWS §8 describes.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  /** Used when AI_PROVIDER is openai-compatible. */
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  /** Unset for OpenAI itself; set for any other provider on the same protocol. */
  AI_BASE_URL: z.string().url().optional(),
  /**
   * Whether the provider honours json_schema strict mode. When false the call
   * falls back to json_object and the Zod parse is the only shape enforcement —
   * deliberately opt-OUT rather than silent, because losing the candidate-id
   * enum is losing the guarantee that a food cannot be invented.
   */
  AI_STRICT_SCHEMA: booleanString.default('true'),

  /**
   * Per-million-token rates, for a model with no entry in the built-in table.
   * Without these an unknown model refuses to run rather than costing zero —
   * a spend ceiling that silently reads 0 is not a ceiling.
   */
  AI_INPUT_USD_PER_MTOK: z.coerce.number().nonnegative().optional(),
  AI_OUTPUT_USD_PER_MTOK: z.coerce.number().nonnegative().optional(),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
  RESOLVE_DAILY_QUOTA: z.coerce.number().int().min(0).default(50),
  RESOLVE_USER_DAILY_SPEND_USD: z.coerce.number().min(0).default(1),

  /** Empty locally: search falls back to trigram only, which is enough for M0. */
  MODEL_PATH: z.string().optional(),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('nutricheck-api'),
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Validation entrypoint for @nestjs/config. Throwing here aborts the bootstrap.
 * The error lists every problem at once — fixing env vars one boot at a time is
 * a bad way to spend a deploy window.
 */
export function validateConfig(raw: Record<string, unknown>): AppConfig {
  // An empty env var is unset, not "present but invalid". Container platforms
  // and templated ConfigMaps routinely render an unfilled optional as "", and
  // without this every `.optional()` in the schema would reject it at boot.
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== ''),
  );

  const parsed = configSchema.safeParse(cleaned);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  if (
    parsed.data.AI_PROVIDER === 'openai-compatible' &&
    parsed.data.ANTHROPIC_API_KEY &&
    !parsed.data.AI_API_KEY
  ) {
    throw new Error(
      'AI_PROVIDER is openai-compatible but only ANTHROPIC_API_KEY is set. ' +
        'Set AI_API_KEY, or leave AI_PROVIDER as anthropic.',
    );
  }

  // Production must not run on the placeholder secrets from .env.example.
  if (parsed.data.NODE_ENV === 'production') {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (parsed.data[key].startsWith('dev-only-')) {
        throw new Error(`${key} is still set to the development placeholder`);
      }
    }
  }

  return parsed.data;
}
