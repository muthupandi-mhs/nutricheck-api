import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { StepsReport } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LogStepsDto, StepsDateParamDto, StepsQueryDto } from './steps.dto';
import { StepsService } from './steps.service';

/**
 * On `me`, beside weight and goals, for the same reason `WeightController` is:
 * this is a fact about the user, not a resource with a life of its own.
 */
@ApiTags('me')
@Controller({ path: 'me', version: '1' })
export class StepsController {
  constructor(private readonly steps: StepsService) {}

  @Get('steps')
  @ApiOperation({ summary: 'Step history, gap-filled, with the aggregates over it' })
  report(
    @CurrentUser('sub') userId: string,
    @Query() query: StepsQueryDto,
  ): Promise<StepsReport> {
    return this.steps.report(userId, query.days);
  }

  /**
   * Returns the whole report, not the point that was written — same reasoning
   * as `WeightController.log`: every figure on the screen (the chart, the
   * totals, the average) moves when a reading lands.
   *
   * 200, not 201: the row is an upsert on (user, day).
   */
  @Post('steps')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a day of steps' })
  log(
    @CurrentUser('sub') userId: string,
    @Body() body: LogStepsDto,
    @Query() query: StepsQueryDto,
  ): Promise<StepsReport> {
    return this.steps.log(userId, body, query.days);
  }

  @Delete('steps/:date')
  @ApiOperation({ summary: 'Delete one day of steps' })
  remove(
    @CurrentUser('sub') userId: string,
    @Param() params: StepsDateParamDto,
    @Query() query: StepsQueryDto,
  ): Promise<StepsReport> {
    return this.steps.remove(userId, params.date, query.days);
  }
}
