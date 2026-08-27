import type { MealFacts } from '@nutricheck/contracts';
import type {
  AiMealResult,
  IdentifyResult,
  InsightResult,
  ParseResult,
  RerankResult,
} from './ai.schemas';
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

  /**
   * Write one or two sentences about a meal that was just logged.
   *
   * Takes FACTS, not entries: every figure is computed in Postgres from frozen
   * log values before it gets here, and `InsightResult` has no numeric field
   * for the model to put an invented one in. The same reasoning that keeps
   * nutrient values out of `parse` applies — a model doing its own arithmetic
   * states a wrong number as confidently as a right one.
   */
  abstract insight(facts: MealFacts): Promise<AiCallResult<InsightResult>>;

  /** Pick one candidate per item, constrained to an enum of the ids supplied. */
  abstract rerank(items: RerankItem[]): Promise<AiCallResult<RerankResult>>;

  /**
   * Say what an unmatched name might be, in English search terms.
   *
   * Runs only after the corpus has already failed to find the words, and it is
   * the one step whose job is translation rather than judgement. The corpus is
   * written in English — USDA files bitter gourd under "Balsam-pear" — so a
   * Tamil or Tanglish word misses however good the search is, and only 25 of
   * nearly 8,000 USDA rows carry a Tamil alias.
   *
   * `IdentifyResult` holds no food id and no nutrient field, so what comes back
   * is fed to the ordinary search like any other query. A name for a food we do
   * not stock matches nothing and the attempt is recorded as a miss. The model
   * can fail to find a food; it cannot invent one, and it is never the thing
   * that decides which row was meant.
   */
  abstract identify(phrase: string): Promise<AiCallResult<IdentifyResult>>;

  /**
   * Read a whole meal out of one sentence, without consulting the corpus.
   *
   * The deliberate exception to everything above: this is the only step allowed
   * to produce nutrition, and it exists because "rendu muttai and 5 dosai and
   * chutney" ends in a dead end the moment any one of those words is missing
   * from the corpus — which, for Tamil, is most of them.
   *
   * What it returns is per-100g RATES and a gram weight, never totals. The
   * multiplication stays in our code, so the model is trusted for the thing it
   * can only estimate and not for the thing we can compute exactly. Rows built
   * from this are written as source 'ai', owned by the user who said the
   * sentence, with every nutrient state 'imputed' so the app shows them with a
   * `~`. None of that makes an estimate correct; it makes it visible, and keeps
   * it out of everybody else's search.
   */
  abstract interpretMeal(phrase: string): Promise<AiCallResult<AiMealResult>>;

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
