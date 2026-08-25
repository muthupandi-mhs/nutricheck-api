import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RecentsQuery, type Suggestion } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { createZodDto } from '../../common/zod/zod-dto';
import { SuggestionsService } from './suggestions.service';

class RecentsQueryDto extends createZodDto(RecentsQuery) {}

@ApiTags('suggestions')
@Controller({ path: 'suggestions', version: '1' })
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  /**
   * The home screen belongs to this list. If the two-second route is buried one
   * level down, people take the eighteen-second one and conclude the app is
   * tedious.
   */
  @Get('recents')
  @ApiOperation({ summary: 'The repeat strip: recent and frequent foods and meals' })
  recents(
    @CurrentUser('sub') userId: string,
    @Query() query: RecentsQueryDto,
  ): Promise<Suggestion[]> {
    return this.suggestions.recents(userId, query.limit, query.hour);
  }
}
