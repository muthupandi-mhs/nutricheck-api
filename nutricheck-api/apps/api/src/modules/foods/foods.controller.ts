import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateCustomFood, type FoodDetail, type FoodSearchResult } from '@nutricheck/contracts';
import { createZodDto } from '../../common/zod/zod-dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FoodSearchQueryDto } from './foods.dto';

class CreateCustomFoodDto extends createZodDto(CreateCustomFood) {}
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

  /**
   * Where every no-match lands. Two fields, reusable afterwards — asking the
   * user to re-type a food they eat weekly is how a tracker gets deleted.
   */
  @Post('custom')
  @ApiOperation({ summary: 'Create a food the corpus does not have' })
  createCustom(
    @CurrentUser('sub') userId: string,
    @Body() body: CreateCustomFoodDto,
  ): Promise<FoodDetail> {
    return this.foods.createCustom(userId, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One food with its nutrients and household portions' })
  findById(@Param('id', ParseUUIDPipe) id: string): Promise<FoodDetail> {
    return this.foods.findById(id);
  }
}
