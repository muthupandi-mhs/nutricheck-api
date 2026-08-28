import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FoodIdeasQuery, type FoodIdeas } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { createZodDto } from '../../common/zod/zod-dto';
import { IdeasService } from './ideas.service';

class FoodIdeasQueryDto extends createZodDto(FoodIdeasQuery) {}

@ApiTags('ideas')
@Controller({ path: 'ideas', version: '1' })
export class IdeasController {
  constructor(private readonly ideas: IdeasService) {}

  /**
   * What to eat next, given what is left of the day.
   *
   * A GET, and cacheable, because the answer depends on the gap rather than on
   * anything the request carries: the same gap twice is the same list, served
   * from Redis without a second model call.
   *
   * No `QuotaGuard`, deliberately, and it is the one route that leaves it off
   * on purpose rather than by omission. The guard runs before the handler and
   * therefore before the cache, so an exhausted user would be refused a list
   * they had already been shown and already paid for. `IdeasService` checks the
   * same quota itself, after the cache lookup and before the call — which is
   * the only ordering where the ceiling bounds spend without also bounding what
   * the user can look at.
   *
   * Never fails for a missing model. With no API key the service returns the
   * gap with an empty list, exactly as a meal card returns facts with no note.
   */
  @Get()
  @ApiOperation({ summary: 'Foods that would fit the rest of the day' })
  ideasFor(
    @CurrentUser('sub') userId: string,
    @Query() query: FoodIdeasQueryDto,
  ): Promise<FoodIdeas> {
    return this.ideas.ideasFor(userId, query.date, query.tz);
  }
}
