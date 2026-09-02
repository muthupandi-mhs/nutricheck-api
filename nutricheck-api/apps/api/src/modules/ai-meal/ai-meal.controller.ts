import {
  Body,
  Controller,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from '../../common/zod/zod-dto';
import { AiMealDraft, AiMealRequest } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProblemThrottlerGuard } from '../../common/guards/problem-throttler.guard';
import { PROBLEM_TYPES } from '@nutricheck/contracts';
import { ProblemException } from '../../common/problems';
import { QuotaGuard } from '../quota/quota.guard';
import { AiMealService } from './ai-meal.service';

class AiMealDto extends createZodDto(AiMealRequest) {}

@ApiTags('ai-meal')
@UseGuards(ProblemThrottlerGuard, QuotaGuard)
@Controller({ path: 'ai-meal', version: '1' })
export class AiMealController {
  constructor(private readonly aiMeal: AiMealService) {}

  /**
   * Read a spoken meal without touching the corpus.
   *
   * Distinct from POST /v1/resolve rather than replacing it. That route matches
   * against measured rows and is the better answer whenever it can find them;
   * this one always calls the model, always produces estimates, and exists for
   * the sentences the corpus cannot serve — which, for Tamil, is most of them.
   * Keeping both means the choice stays the client's, per utterance, instead of
   * being settled once for everybody by deleting the safer path.
   */
  @Post()
  @ApiOperation({ summary: 'Interpret a spoken meal with AI, bypassing corpus search' })
  async interpret(
    @CurrentUser('sub') userId: string,
    @Body() body: AiMealDto,
  ): Promise<AiMealDraft> {
    // Same degradation as /v1/resolve and /v1/transcribe: no key is a supported
    // state, and 503 tells the client to fall back rather than pretending the
    // request was malformed.
    if (!this.aiMeal.isConfigured) {
      // A typed problem, not a bare ServiceUnavailableException. The client
      // switches on problem.type and never on status, so an untyped 503 falls
      // through its branches and lands on the generic "we could not read that"
      // -- which tells the user their sentence was bad when the truth is the
      // server has no key. Same type the transcription route uses for the same
      // situation.
      throw new ProblemException({
        type: PROBLEM_TYPES.resolverUnavailable,
        title: 'AI is unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'Search for foods one at a time, or try again shortly.',
      });
    }

    // QuotaGuard has already turned an exhausted allowance into a 429 with a
    // reset time, so there is nothing to catch here.
    return this.aiMeal.interpret(userId, body.phrase, body.today);
  }
}

