import { Injectable, Logger } from '@nestjs/common';
import type { SuggestedTargets, UserProfile } from '@nutricheck/contracts';
import { createHash } from 'node:crypto';
import { AiRunsService } from '../ai/ai-runs.service';
import { AiService } from '../ai/ai.service';
import { clampTargets } from './clamp-targets';
import { computeGoal, macrosFor } from './goal-calculator';

/**
 * Targets proposed by the model, corrected by the server.
 *
 * The order of operations here is the whole design, and none of it trusts the
 * model with the last word:
 *
 *   1. The formula runs FIRST. Whatever happens next, there is already a
 *      complete, checkable answer.
 *   2. The model is handed that answer and asked whether it should move. It is
 *      adjusting an anchored figure rather than authoring one from nothing.
 *   3. Whatever comes back is clamped — never below resting burn, never outside
 *      the physiological bounds — and every correction is recorded.
 *
 * The call is billed and recorded like every other model call. It is one per
 * onboarding rather than one per meal, so it is cheap; recording it anyway is
 * what keeps `ai_runs` a complete account of spend rather than a partial one.
 */
@Injectable()
export class SuggestedTargetsService {
  private readonly log = new Logger(SuggestedTargetsService.name);

  constructor(
    private readonly ai: AiService,
    private readonly aiRuns: AiRunsService,
  ) {}

  get isConfigured(): boolean {
    return this.ai.isConfigured;
  }

  async suggest(userId: string, profile: UserProfile): Promise<SuggestedTargets> {
    const derived = computeGoal(profile);

    const result = await this.ai.suggestTargets(profile, derived);

    await this.aiRuns
      .recordCall(userId, 'targets', hashOf(profile), result)
      .catch((error: unknown) => {
        // The same trade the insight path makes: losing the row is an
        // accounting problem, and it must not cost the user an answer that has
        // already been paid for.
        this.log.error(
          { reason: error instanceof Error ? error.message : 'unknown' },
          'targets suggestion was not recorded — its cost is missing from attribution',
        );
      });

    const clamped = agreesWithFormula(clampTargets(result.value, profile, derived), derived);

    if (clamped.corrections.length > 0) {
      // Worth a log line of its own. A model that regularly proposes figures
      // outside the bounds is a prompt problem, and the only place that would
      // otherwise show up is a user noticing their target moved.
      this.log.warn(
        { corrections: clamped.corrections, promptVersion: result.promptVersion },
        'suggested targets were corrected',
      );
    }

    // Recomputed from the figures that survived clamping, never carried over
    // from the derived goal: if the calorie target moved, the macros under it
    // moved with it.
    const macros = macrosFor(clamped.kcal, clamped.proteinG);

    return {
      kcal: clamped.kcal,
      proteinG: clamped.proteinG,
      carbsG: macros.carbsG,
      fatG: macros.fatG,
      fiberG: clamped.fiberG,
      reasoning: result.value.reasoning,
      corrections: clamped.corrections,
    };
  }
}

/**
 * Below this, a difference is noise rather than advice.
 *
 * A model that returns 2,280 against a calculated 2,294 has not made a
 * judgement, it has jittered — and the screen would offer that as a suggestion
 * to accept, with a button.
 *
 * Deliberately tight on the two small numbers. Calories arrive in the
 * thousands, so a difference of twenty-five is inside the rounding of the
 * formula itself; protein and fibre arrive in the tens, where a change of two
 * or three grams is a decision somebody made. One run of this moved fibre from
 * 32 to 30 and said why, and a wider width would have quietly put it back —
 * overriding the judgement the model was asked for, while its own sentence
 * still described it.
 */
const SAME_KCAL = 25;
const SAME_PROTEIN_G = 1;
const SAME_FIBER_G = 1;

/**
 * Snaps a suggestion back onto the formula when it never really left.
 *
 * The prompt asks for the given figures exactly when the model is not changing
 * anything, and mostly it obliges. This is what happens when it does not: a
 * near-miss becomes an exact match, so the screen shows agreement rather than
 * offering a fourteen-calorie difference as a decision to make.
 *
 * Only when ALL THREE are within their width. One real change plus two
 * near-misses is a real change, and rounding the other two would quietly
 * rewrite the parts of the answer the model did mean.
 */
function agreesWithFormula<T extends { kcal: number; proteinG: number; fiberG: number }>(
  suggested: T,
  derived: { kcal: number; proteinG: number; fiberG: number },
): T {
  const same =
    Math.abs(suggested.kcal - derived.kcal) <= SAME_KCAL &&
    Math.abs(suggested.proteinG - derived.proteinG) <= SAME_PROTEIN_G &&
    Math.abs(suggested.fiberG - derived.fiberG) <= SAME_FIBER_G;

  if (!same) return suggested;

  return {
    ...suggested,
    kcal: derived.kcal,
    proteinG: derived.proteinG,
    fiberG: derived.fiberG,
  };
}

/**
 * The profile that produced a suggestion, as one hash.
 *
 * The inputs rather than the user: two people with the same body and the same
 * goal are the same question, and the row is for cost attribution and prompt
 * regression rather than for identifying anybody.
 */
function hashOf(profile: UserProfile): string {
  return createHash('sha256')
    .update(
      [
        profile.sex,
        profile.birthDate,
        profile.heightCm,
        profile.weightKg,
        profile.activityLevel,
        profile.objective,
        profile.rateKgPerWeek,
      ].join('|'),
    )
    .digest('hex');
}
