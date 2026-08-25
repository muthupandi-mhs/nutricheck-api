import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateMeal,
  LogMealRequest,
  type LogEntry,
  type SavedMeal,
} from '@nutricheck/contracts';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { createZodDto } from '../../common/zod/zod-dto';
import { MealsService } from './meals.service';

class CreateMealDto extends createZodDto(CreateMeal) {}
class LogMealDto extends createZodDto(LogMealRequest) {}

@ApiTags('meals')
@Controller({ path: 'meals', version: '1' })
export class MealsController {
  constructor(private readonly meals: MealsService) {}

  @Get()
  @ApiOperation({ summary: 'Saved meals' })
  list(@CurrentUser('sub') userId: string): Promise<SavedMeal[]> {
    return this.meals.list(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One saved meal' })
  findById(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SavedMeal> {
    return this.meals.findById(userId, id);
  }

  /** From explicit items, or from a log entry that already worked. */
  @Post()
  @ApiOperation({ summary: 'Save a meal' })
  create(
    @CurrentUser('sub') userId: string,
    @Body() body: CreateMealDto,
  ): Promise<SavedMeal> {
    return this.meals.create(userId, body);
  }

  /**
   * One tap. Goes through the ordinary commit path, so freeze-at-commit and
   * idempotency apply identically — there is no second way to write a log.
   */
  @Post(':id/log')
  @ApiOperation({ summary: 'Log every item of a saved meal at once' })
  async log(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LogMealDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LogEntry> {
    const { entry, created } = await this.meals.log(userId, id, body);
    void reply.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return entry;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Forget a saved meal' })
  remove(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.meals.remove(userId, id);
  }
}
