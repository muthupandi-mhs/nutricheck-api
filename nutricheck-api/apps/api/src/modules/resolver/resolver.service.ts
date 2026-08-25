import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  FoodSummary,
  Quantity,
  ResolveDraft,
  ResolveRequest,
  ResolvedItem,
} from '@nutricheck/contracts';
import { schema, type Database } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import {
  ResolverTimeoutException,
  ResolverUnavailableException,
} from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { AiRunsService } from '../ai/ai-runs.service';
import {
  AiMalformedError,
  AiRefusedError,
  AiService,
  AiUnavailableError,
} from '../ai/ai.service';
import type { ParsedItem } from '../ai/ai.schemas';
import { FoodsService } from '../foods/foods.service';
import { computeItemNutrients } from '../logs/nutrition-calculator';
import { QuotaService } from '../quota/quota.service';
import { DraftStoreService } from './draft-store.service';
import { PortionPrefillService, rangeForUnit } from './portion-prefill.service';

/** Emitted as SSE so the sheet fills in rather than showing a spinner. */
export type ResolveEvent =
  | { event: 'parsed'; items: Array<Pick<ResolvedItem, 'itemId' | 'matchedText' | 'quantity'>>; unresolved: Array<{ text: string }> }
  | { event: 'resolved'; draft: ResolveDraft }
  | { event: 'done'; draftId: string; aiRunId: string | null; latencyMs: number };

/**
 * The resolver.
 *
 * One path, three front doors. Every stage is an injected collaborator, which
 * is what makes the pipeline testable without a network — and the reason the
 * parked photo route will be a fourth adapter rather than a re-architecture.
 *
 * The model never emits a nutrient value. It reads what was said and how much;
 * identification is a constrained pick from real rows; every number is a
 * multiplication. When a log comes out wrong, exactly one step is responsible.
 */
@Injectable()
export class ResolverService {
  private readonly logger = new Logger(ResolverService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ai: AiService,
    private readonly aiRuns: AiRunsService,
    private readonly foods: FoodsService,
    private readonly portions: PortionPrefillService,
    private readonly drafts: DraftStoreService,
    private readonly quota: QuotaService,
  ) {}

  /**
   * Streaming resolve.
   *
   * Yields `parsed` as soon as items and quantities exist so the sheet can
   * render real labels on skeleton rows — two seconds of visible progress feels
   * shorter than two seconds of blank screen.
   */
  async *resolve(
    userId: string,
    request: ResolveRequest,
  ): AsyncGenerator<ResolveEvent> {
    const started = Date.now();

    if (!this.ai.isConfigured) throw new ResolverUnavailableException();

    const model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
    const cacheKey = this.drafts.phraseKey(userId, request.phrase, model);
    const inputHash = this.drafts.inputHash(userId, request.phrase, model);

    // --- phrase cache ------------------------------------------------------
    const cached = await this.drafts.getCachedDraft(cacheKey);
    if (cached) {
      const draft: ResolveDraft = { ...cached, draftId: randomUUID(), cached: true };
      await this.drafts.putDraft(draft);
      // Logged anyway, with zero cost, so dashboards and eval sampling stay
      // representative of real traffic rather than only of cache misses.
      await this.aiRuns.recordCacheHit(userId, inputHash, model, 'cached');

      yield { event: 'parsed', items: draft.items.map(toSkeleton), unresolved: draft.unresolved };
      yield { event: 'resolved', draft };
      yield { event: 'done', draftId: draft.draftId, aiRunId: null, latencyMs: Date.now() - started };
      return;
    }

    await this.quota.consume(userId);

    try {
      // --- 1. portion prefill, BEFORE the model sees the phrase ------------
      const knownUnits = await this.portions.knownUnits(userId);

      // --- 2. parse --------------------------------------------------------
      const parsed = await this.ai.parse(
        request.phrase,
        knownUnits.map((u) => ({ label: u.label, grams: u.grams })),
      );
      const parseRunId = await this.aiRuns.recordCall(userId, 'parse', inputHash, parsed);

      const items = parsed.value.items;
      const unresolved = parsed.value.unresolved.map((text) => ({ text }));

      // Nothing parsed is not an error — it is the "we couldn't read that"
      // path, and the client falls back to search with the phrase pre-filled.
      if (items.length === 0) {
        const draft = this.emptyDraft(request, unresolved, parseRunId);
        await this.drafts.putDraft(draft);
        yield { event: 'parsed', items: [], unresolved };
        yield { event: 'resolved', draft };
        yield { event: 'done', draftId: draft.draftId, aiRunId: parseRunId, latencyMs: Date.now() - started };
        return;
      }

      // Quantities are resolvable without the corpus, so the skeleton can show
      // real labels before the search and re-rank have finished.
      const quantities = await Promise.all(
        items.map((item) => this.toQuantity(userId, item)),
      );
      const itemIds = items.map(() => randomUUID());

      yield {
        event: 'parsed',
        items: items.map((item, i) => ({
          itemId: itemIds[i]!,
          matchedText: item.matchedText,
          quantity: quantities[i]!,
        })),
        unresolved,
      };

      // --- 3. candidate search: ONE query for every item -------------------
      const candidates = await this.foods.searchMany(
        userId,
        items.map((i) => i.foodPhrase),
        8,
      );

      // --- 4. re-rank, constrained to the ids the search returned ----------
      const rerankable = items
        .map((item, index) => ({
          index,
          phrase: item.foodPhrase,
          candidates: candidates.get(index) ?? [],
        }))
        .filter((item) => item.candidates.length > 0);

      const picks = new Map<number, { foodId: string; confidence: 'high' | 'low' }>();
      let rerankRunId: string | null = null;

      if (rerankable.length > 0) {
        const reranked = await this.ai.rerank(rerankable);
        rerankRunId = await this.aiRuns.recordCall(userId, 'rerank', inputHash, reranked);
        for (const pick of reranked.value.picks) {
          picks.set(pick.itemIndex, {
            foodId: pick.foodId,
            confidence: pick.confidence,
          });
        }
      }

      // --- 5. arithmetic ---------------------------------------------------
      const resolved: ResolvedItem[] = [];
      const misses: Array<{ itemText: string }> = [];

      for (const [index, item] of items.entries()) {
        const options = candidates.get(index) ?? [];
        let pick = picks.get(index);

        // A model that returns fewer picks than it was given items would
        // otherwise make food the user typed disappear. Observed live: two
        // items in, one pick out, and "an apple" silently became unresolved
        // despite the corpus having apples and the search returning them.
        //
        // Falling back to the top-ranked candidate at low confidence is
        // strictly better than dropping it: the user sees a row they can
        // correct in one tap instead of an item that vanished.
        if (!pick && options.length > 0) {
          this.logger.warn(
            { itemIndex: index, phrase: item.foodPhrase },
            're-rank omitted an item — falling back to the top candidate',
          );
          pick = { foodId: options[0]!.id, confidence: 'low' };
        }

        const food = options.find((c) => c.id === pick?.foodId) ?? null;

        if (!food) {
          // Nothing matched: the words become a scoped search row rather than
          // being dropped silently or having a row invented for them.
          misses.push({ itemText: item.foodPhrase });
          unresolved.push({ text: item.matchedText });
          continue;
        }

        if (pick?.confidence === 'low') misses.push({ itemText: item.foodPhrase });

        // One read, used for both the portion table and the arithmetic.
        const detail = await this.foods.findById(food.id);
        const quantity = resolveAgainstFood(quantities[index]!, item, detail.portions);

        resolved.push({
          itemId: itemIds[index]!,
          matchedText: item.matchedText,
          quantity,
          food,
          candidates: options,
          confidence: pick?.confidence ?? 'low',
          nutrients:
            quantity.grams === null
              ? null
              : computeItemNutrients(
                  {
                    kcal: detail.nutrients.kcal,
                    proteinG: detail.nutrients.proteinG,
                    fiberG: detail.nutrients.fiberG,
                    fiberState: detail.nutrients.fiberState,
                  },
                  quantity.grams,
                ),
        });
      }

      await this.recordMisses(userId, request.phrase, misses);

      const draft: ResolveDraft = {
        draftId: randomUUID(),
        phrase: request.phrase,
        source: request.source,
        items: resolved,
        unresolved,
        aiRunId: rerankRunId ?? parseRunId,
        cached: false,
      };

      await this.drafts.putDraft(draft);
      // Only a fully resolved draft is worth caching; a partial one would
      // freeze a bad result for 24 hours.
      if (unresolved.length === 0 && resolved.length > 0) {
        await this.drafts.putCachedDraft(cacheKey, draft);
      }

      yield { event: 'resolved', draft };
      yield {
        event: 'done',
        draftId: draft.draftId,
        aiRunId: draft.aiRunId,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      // A failed call should not cost the user a quota unit.
      await this.quota.refund(userId).catch(() => undefined);

      if (error instanceof AiUnavailableError) throw new ResolverUnavailableException();
      if (error instanceof AiRefusedError) {
        this.logger.warn({ category: error.category }, 'model declined a resolve');
        throw new ResolverUnavailableException();
      }
      if (error instanceof AiMalformedError) throw new ResolverTimeoutException();
      throw error;
    }
  }

  /** Non-streaming form. Must produce a byte-identical draft to the SSE path. */
  async resolveOnce(userId: string, request: ResolveRequest): Promise<ResolveDraft> {
    let draft: ResolveDraft | null = null;
    for await (const event of this.resolve(userId, request)) {
      if (event.event === 'resolved') draft = event.draft;
    }
    if (!draft) throw new ResolverTimeoutException();
    return draft;
  }

  async getDraft(draftId: string): Promise<ResolveDraft | null> {
    return this.drafts.getDraft(draftId);
  }

  /**
   * Turn a parsed quantity into grams.
   *
   * The one rule that matters: `none_given` and an unlearned personal unit both
   * yield null grams. Nothing here substitutes a default. A silently invented
   * 100 g is where a wrong week starts.
   */
  private async toQuantity(userId: string, item: ParsedItem): Promise<Quantity> {
    const raw = [item.quantityValue, item.quantityUnit].filter(Boolean).join(' ').trim()
      || item.matchedText;

    if (item.quantityType === 'none_given') {
      return { type: 'none_given', raw, grams: null, source: 'unknown', range: null };
    }

    if (item.quantityType === 'exact_mass' && item.quantityValue) {
      const grams = toGrams(item.quantityValue, item.quantityUnit);
      if (grams !== null) {
        return { type: 'exact_mass', raw, grams, source: 'stated', range: null };
      }
    }

    if (item.quantityType === 'personal_unit' && item.quantityUnit) {
      const learned = await this.portions.resolve(userId, item.quantityUnit, null);
      if (learned) {
        return {
          type: 'personal_unit',
          raw,
          grams: learned.grams * (item.quantityValue ?? 1),
          source: 'user_portion',
          range: null,
        };
      }
      // Never measured. A range here is honesty, not noise — and the sheet
      // turns the first correction into a permanent answer.
      return {
        type: 'personal_unit',
        raw,
        grams: null,
        source: 'unknown',
        range: rangeForUnit(item.quantityUnit),
      };
    }

    // count and standard_measure need the food's portion table, which is not
    // known until the re-rank has chosen a row. Left null here and resolved by
    // resolveAgainstFood() once the food is known.
    return {
      type: item.quantityType,
      raw,
      grams: null,
      source: 'unknown',
      range: null,
    };
  }

  /**
   * The curation queue. Every low-confidence match and every unmatched phrase
   * lands here with the user's exact words — searchable and groupable, which is
   * what makes "which dishes do we add next" a weekly query instead of a guess.
   */
  private async recordMisses(
    userId: string,
    phrase: string,
    misses: Array<{ itemText: string }>,
  ): Promise<void> {
    if (misses.length === 0) return;
    await this.db.insert(schema.matchMisses).values(
      misses.map((miss) => ({ userId, phrase, itemText: miss.itemText })),
    );
  }

  private emptyDraft(
    request: ResolveRequest,
    unresolved: Array<{ text: string }>,
    aiRunId: string | null,
  ): ResolveDraft {
    return {
      draftId: randomUUID(),
      phrase: request.phrase,
      source: request.source,
      items: [],
      unresolved: unresolved.length > 0 ? unresolved : [{ text: request.phrase }],
      aiRunId,
      cached: false,
    };
  }
}

/**
 * Resolve a count or a standard measure against the chosen food's portions.
 *
 * Only possible after the re-rank: "two rotis" is 90 g or 300 g depending on
 * which row was picked, so this cannot happen at parse time.
 *
 * Returns the quantity unchanged when nothing matches, which leaves grams null
 * and makes the sheet ask. That is the point — inventing a portion here would
 * be the same mistake as inventing an amount, one step later.
 */
export function resolveAgainstFood(
  quantity: Quantity,
  item: ParsedItem,
  portions: ReadonlyArray<{ label: string; grams: number; isDefault: boolean }>,
): Quantity {
  if (quantity.grams !== null) return quantity;
  if (quantity.type !== 'count' && quantity.type !== 'standard_measure') return quantity;
  if (portions.length === 0) return quantity;

  const count = item.quantityValue ?? 1;
  const unit = (item.quantityUnit ?? '').trim().toLowerCase();

  // A label like "1 cup, quartered or chopped" should match the unit "cup".
  const byUnit = unit
    ? portions.find((p) => labelWords(p.label).includes(unit))
    : undefined;

  if (byUnit) {
    return {
      ...quantity,
      grams: round2(byUnit.grams * count),
      source: 'food_portion',
    };
  }

  // A count of a food with no matching label means "that many of them", so the
  // default portion is the right unit: two rotis is two of whatever one roti is.
  // A standard measure gets no such fallback — resolving "a cup of rice" via a
  // portion labelled "1 medium apple" would be nonsense.
  if (quantity.type === 'count') {
    const fallback = portions.find((p) => p.isDefault) ?? portions[0]!;
    return {
      ...quantity,
      grams: round2(fallback.grams * count),
      source: 'food_portion',
    };
  }

  return quantity;
}

/** Singularized words of a portion label, for matching a stated unit. */
function labelWords(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => (word.endsWith('s') ? [word, word.slice(0, -1)] : [word]));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toSkeleton(item: ResolvedItem) {
  return { itemId: item.itemId, matchedText: item.matchedText, quantity: item.quantity };
}

/** Mass and volume units only. Anything else is not an exact mass. */
function toGrams(value: number, unit: string | null): number | null {
  const normalized = (unit ?? '').trim().toLowerCase();
  const factors: Record<string, number> = {
    g: 1, gram: 1, grams: 1, gm: 1,
    kg: 1000, kilogram: 1000, kilograms: 1000,
    mg: 0.001,
    oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
    lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
    // Water-equivalent density. Wrong for oil and honey, right for the drinks
    // people actually state in millilitres.
    ml: 1, milliliter: 1, millilitre: 1, l: 1000, liter: 1000, litre: 1000,
  };
  const factor = factors[normalized];
  return factor === undefined ? null : Math.round(value * factor * 100) / 100;
}
