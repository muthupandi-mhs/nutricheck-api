import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MealInsightQuery, type MealInsight } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { createZodDto } from '../../common/zod/zod-dto';
import { InsightsService } from './insights.service';

class MealInsightQueryDto extends createZodDto(MealInsightQuery) {}

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
}
