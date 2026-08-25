import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FoodDetail, FoodSearchResult } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FoodSearchQueryDto } from './foods.dto';
import { FoodsService } from './foods.service';

/**
 * The route with no model in it. It is the floor under everything else and the
 * first log a new user ever makes, so it has to be genuinely good rather than a
 * grudging fallback — every failed parse in the resolver lands here.
 */
@ApiTags('foods')
@Controller({ path: 'foods', version: '1' })
export class FoodsController {
  constructor(private readonly foods: FoodsService) {}

  @Get('search')
  @ApiOperation({ summary: 'Search the food corpus (no AI involved)' })
  search(
    @CurrentUser('sub') userId: string,
    @Query() query: FoodSearchQueryDto,
  ): Promise<FoodSearchResult[]> {
    return this.foods.search(userId, query.q, query.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One food with its nutrients and household portions' })
  findById(@Param('id', ParseUUIDPipe) id: string): Promise<FoodDetail> {
    return this.foods.findById(id);
  }
}
