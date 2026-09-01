import type { GoalPreview, MealFacts, UserProfile } from '@nutricheck/contracts';
import type { IdeasInput } from './ideas-input';
import type {
  AiMealResult,
  ChatResult,
  IdeasResult,
  IdentifyResult,
  InsightResult,
  TargetsResult,
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

  /**
   * Suggest daily targets for one person.
   *
   * The one step besides `interpretMeal` whose output is numbers, and the only
   * one whose numbers are about months rather than a plate. Two things carry
   * that weight, and neither is the model:
   *
   * - it is handed the formula's answer and asked whether it should move, so it
   *   is adjusting an anchored figure rather than authoring one from nothing;
   * - whatever it returns goes through `clampTargets`, which holds it inside
   *   the same limits the derived goal obeys and never lets calories fall below
   *   resting burn.
   *
   * The reasoning is returned with the numbers on purpose. A target with no
   * argument attached is one nobody can disagree with.
   */
  abstract suggestTargets(
    profile: UserProfile,
    derived: GoalPreview,
  ): Promise<AiCallResult<TargetsResult>>;

  /**
   * Suggest what somebody could eat next, given what is left of their day.
   *
   * The third step allowed to produce nutrition, and the only one that runs
   * without anybody having asked a question — it fires because a tab was
   * opened. That is a weaker justification than either of the others has, and
   * the containment is correspondingly tighter rather than looser:
   *
   * - RATES, NOT TOTALS, as on `interpretMeal`. Every figure the user reads is
   *   a product computed on the server from a per-100g rate and a gram weight.
   * - Everything it is given is already computed. The gap it is suggesting
   *   against is handed over as a figure, so there is no arithmetic left for it
   *   to get wrong.
   * - Whatever comes back is Atwater-checked before it is shown, and an item
   *   whose calories disagree with its own macros is DROPPED. That check is
   *   arithmetic we can do exactly, and a model that fails it has not made a
   *   rounding error.
   *
   * `reason` is required per idea for the same purpose `reasoning` serves on
   * the targets step: a number with an argument attached can be disagreed with,
   * and one without it can only be believed or ignored.
   */
  abstract suggestFoods(input: IdeasInput): Promise<AiCallResult<IdeasResult>>;

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

  /**
   * One turn of the assistant: a message plus the day it is about.
   *
   * The only open-ended call in this system — every other one answers a shaped
   * question, and this one has to work out what it was asked before it can
   * answer. What comes back is something to say and, when the message was food,
   * the user's own words to log.
   *
   * It produces no nutrition. A meal goes on to `interpretMeal`, which is the
   * one place allowed to put numbers on food, so the figure somebody is told
   * here and the figure they are shown two seconds later cannot disagree.
   */
  abstract chat(turn: string): Promise<AiCallResult<ChatResult>>;

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
