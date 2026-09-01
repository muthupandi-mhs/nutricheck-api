import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  MealInsightQuery,
  WeekReviewQuery,
  type MealInsight,
  type WeekReview,
} from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { createZodDto } from '../../common/zod/zod-dto';
import { InsightsService } from './insights.service';

class MealInsightQueryDto extends createZodDto(MealInsightQuery) {}
class WeekReviewQueryDto extends createZodDto(WeekReviewQuery) {}

@ApiTags('insights')
@Controller({ path: 'insights', version: '1' })
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /**
   * The note under a meal card.
   *
   * A GET, and cacheable, because the answer depends only on what is in the
   * meal — the same request twice is the same note, served from Redis without
   * a second model call. `facts` is always populated even when the prose is
   * empty, so the screen has something to render whatever the model did.
   */
  @Get('meal')
  @ApiOperation({ summary: 'A short written note about one logged meal' })
  meal(
    @CurrentUser('sub') userId: string,
    @Query() query: MealInsightQueryDto,
  ): Promise<MealInsight> {
    return this.insights.mealInsight(userId, query.date, query.meal, query.tz);
  }

  /**
   * The week in review, above the charts on Insights.
   *
   * A GET, and cacheable, for the reason the meal note is: the answer depends
   * only on the seven days behind the date, so the same week twice is the same
   * review, served from Redis without a second model call. A finished week is
   * served that way for a month.
   *
   * No `QuotaGuard`, and it is the same deliberate omission `IdeasController`
   * makes rather than an oversight. The guard runs before the handler and
   * therefore before the cache, so an exhausted user would be refused a review
   * they have already been shown and already paid for. `InsightsService` checks
   * the same quota itself, after the cache lookup and before the call — the
   * only ordering where the ceiling bounds spend without also bounding what the
   * user can look at.
   *
   * Never fails for a missing model. With no API key, a refusal or a timeout,
   * `text` is empty and `facts` is complete, and the card renders the figures
   * with no prose — exactly as a meal card does.
   */
  @Get('week')
  @ApiOperation({ summary: "A short written review of somebody's week" })
  week(
    @CurrentUser('sub') userId: string,
    @Query() query: WeekReviewQueryDto,
  ): Promise<WeekReview> {
    return this.insights.weekReview(userId, query.date, query.tz);
  }
}
