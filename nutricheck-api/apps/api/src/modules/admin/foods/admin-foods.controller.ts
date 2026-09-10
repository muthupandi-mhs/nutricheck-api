import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminFoodDetail, AdminFoodListResponse } from '@nutricheck/contracts';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { AdminCreateFoodDto, AdminFoodListQueryDto, AdminUpdateFoodDto } from './admin-foods.dto';
import { AdminFoodsService } from './admin-foods.service';

@Public()
@UseGuards(AdminAuthGuard)
@ApiTags('admin-foods')
@Controller({ path: 'admin/foods', version: '1' })
export class AdminFoodsController {
  constructor(private readonly foods: AdminFoodsService) {}

  @Get()
  @ApiOperation({ summary: 'Search and list the food corpus' })
  list(@Query() query: AdminFoodListQueryDto): Promise<AdminFoodListResponse> {
    return this.foods.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One food with its nutrients, portions and aliases' })
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<AdminFoodDetail> {
    return this.foods.detail(id);
  }

  @Post()
  @ApiOperation({ summary: 'Curate a new food into the corpus' })
  create(@Body() body: AdminCreateFoodDto): Promise<AdminFoodDetail> {
    return this.foods.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a food — nutrition is replaced as a whole, never merged' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: AdminUpdateFoodDto): Promise<AdminFoodDetail> {
    return this.foods.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a curated or user food — refused for USDA/OFF rows and rows in use' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.foods.remove(id);
  }
}
