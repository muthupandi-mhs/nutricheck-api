import { Injectable, Logger } from '@nestjs/common';
import type { SuggestedTargets, UserProfile } from '@nutricheck/contracts';
import { createHash } from 'node:crypto';
import { AiRunsService } from '../ai/ai-runs.service';
import { AiService } from '../ai/ai.service';
import { clampTargets } from './clamp-targets';
import { computeGoal } from './goal-calculator';

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

    const clamped = clampTargets(result.value, profile, derived);

    if (clamped.corrections.length > 0) {
      // Worth a log line of its own. A model that regularly proposes figures
      // outside the bounds is a prompt problem, and the only place that would
      // otherwise show up is a user noticing their target moved.
      this.log.warn(
        { corrections: clamped.corrections, promptVersion: result.promptVersion },
        'suggested targets were corrected',
      );
    }

    return {
      kcal: clamped.kcal,
      proteinG: clamped.proteinG,
      fiberG: clamped.fiberG,
      reasoning: result.value.reasoning,
      corrections: clamped.corrections,
    };
  }
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
