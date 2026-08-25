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
};

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
  const rates = RATES[model];
  if (!rates) {
    // An unknown model must not silently cost zero — that would make a
    // misconfigured model id look free right up until the invoice.
    throw new Error(
      `No rate table for model "${model}". Add it to cost.ts before using it.`,
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
