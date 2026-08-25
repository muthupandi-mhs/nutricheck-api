import type { ParseResult, RerankResult } from './ai.schemas';
import type { TokenUsage } from './cost';

/**
 * What the resolver is allowed to know about the model.
 *
 * The resolver depends on this interface, never on the concrete client, so the
 * whole pipeline is unit-testable without a network and the eval harness can
 * swap in a recorded transport. `@anthropic-ai/sdk` is importable from
 * modules/ai/** only.
 */
export interface AiCallResult<T> {
  value: T;
  usage: TokenUsage;
  latencyMs: number;
  stopReason: string | null;
  model: string;
  promptVersion: string;
  /** Raw response, stored on ai_runs for 30 days so any bad log can be replayed. */
  raw: unknown;
}

export interface RerankCandidate {
  id: string;
  name: string;
  kcalPer100g: number;
}

export interface RerankItem {
  index: number;
  phrase: string;
  candidates: RerankCandidate[];
}

export abstract class AiService {
  /**
   * Turn a phrase into items and quantities. Returns no nutrient values —
   * there is no field in the schema in which it could.
   *
   * `knownUnits` carries this user's learned personal units and MUST be placed
   * in the user turn, never interpolated into the system prompt: the prompt is
   * the cached prefix, and making it per-user silently triples the bill.
   */
  abstract parse(
    phrase: string,
    knownUnits: ReadonlyArray<{ label: string; grams: number }>,
  ): Promise<AiCallResult<ParseResult>>;

  /** Pick one candidate per item, constrained to an enum of the ids supplied. */
  abstract rerank(items: RerankItem[]): Promise<AiCallResult<RerankResult>>;

  /** False when no API key is configured — the resolver route stays disabled. */
  abstract get isConfigured(): boolean;
}

export class AiUnavailableError extends Error {}
export class AiRefusedError extends Error {
  constructor(readonly category: string | null) {
    super('the model declined this request');
  }
}
export class AiMalformedError extends Error {}
