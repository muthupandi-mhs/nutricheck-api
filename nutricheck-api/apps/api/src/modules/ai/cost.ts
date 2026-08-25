/**
 * Cost accounting.
 *
 * Rates live in a table keyed by model id rather than inline at the call site,
 * so switching models cannot silently keep billing at the old price, and a
 * price change is one edit rather than a grep.
 *
 * USD per million tokens.
 */
export interface ModelRates {
  input: number;
  output: number;
  /** Cache reads bill at ~0.1x input. */
  cacheReadMultiplier: number;
  /** 5-minute-TTL cache writes bill at ~1.25x input. */
  cacheWriteMultiplier: number;
}

/**
 * Built-in rates. A model that is not here can still be costed by setting
 * AI_INPUT_USD_PER_MTOK / AI_OUTPUT_USD_PER_MTOK — see costUsd below.
 */
const RATES: Record<string, ModelRates> = {
  'claude-opus-5': {
    input: 5,
    output: 25,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
  },
  'claude-sonnet-5': {
    input: 2,
    output: 10,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
  },
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
  },
  // OpenAI-compatible providers. Prefix caching there is automatic and bills at
  // a discount rather than being requested, so there is no write premium to
  // model — cacheWriteMultiplier is 1.
  'gpt-4o': { input: 2.5, output: 10, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 1 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheReadMultiplier: 0.5, cacheWriteMultiplier: 1 },
  'gpt-4.1': { input: 2, output: 8, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1 },
};

/** Set from config when the model has no built-in entry. */
let fallbackRates: ModelRates | null = null;

export function setFallbackRates(inputPerMTok?: number, outputPerMTok?: number): void {
  fallbackRates =
    inputPerMTok === undefined || outputPerMTok === undefined
      ? null
      : {
          input: inputPerMTok,
          output: outputPerMTok,
          cacheReadMultiplier: 1,
          cacheWriteMultiplier: 1,
        };
}

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/**
 * Returns a string, not a number: this is summed per user for the spend ceiling
 * and stored in a numeric(12,6) column, and accumulating float cents across
 * millions of rows is how a ceiling ends up off by a percent.
 */
export function costUsd(model: string, usage: TokenUsage): string {
  const rates = RATES[model] ?? fallbackRates;
  if (!rates) {
    // An unknown model must not silently cost zero — that would make a
    // misconfigured model id look free right up until the invoice, and it would
    // make the per-user spend ceiling read 0 forever.
    throw new Error(
      `No rate table for model "${model}". Add it to cost.ts, or set ` +
        'AI_INPUT_USD_PER_MTOK and AI_OUTPUT_USD_PER_MTOK.',
    );
  }

  const perToken = (rate: number): number => rate / 1_000_000;

  const total =
    usage.inputTokens * perToken(rates.input) +
    usage.cacheReadTokens * perToken(rates.input) * rates.cacheReadMultiplier +
    usage.cacheWriteTokens * perToken(rates.input) * rates.cacheWriteMultiplier +
    usage.outputTokens * perToken(rates.output);

  return total.toFixed(6);
}

export function knownModels(): string[] {
  return Object.keys(RATES);
}

/**
 * Share of billable input served from cache, 0-1.
 *
 * The single most useful number on the dashboard. If it drops toward zero
 * across repeated requests, a silent cache invalidator is at work — and the one
 * that will actually happen here is per-user portion context leaking into the
 * system prompt instead of the user turn.
 */
export function cacheHitRatio(usage: TokenUsage): number {
  const billableInput = usage.inputTokens + usage.cacheReadTokens;
  return billableInput === 0 ? 0 : usage.cacheReadTokens / billableInput;
}
