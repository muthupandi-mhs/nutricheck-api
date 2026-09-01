import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { WeightSeries } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LogWeightDto, WeightDateParamDto, WeightSeriesQueryDto } from './weight.dto';
import { WeightService } from './weight.service';

/**
 * On `me` rather than a path of its own, beside the profile and the goals,
 * because that is what a weight is: a fact about the user, not a resource with
 * a life of its own. GoalsController and UsersController already share this
 * prefix — Nest merges controllers on one path, and the routes here are static
 * and collide with neither.
 */
@ApiTags('me')
@Controller({ path: 'me', version: '1' })
export class WeightController {
  constructor(private readonly weight: WeightService) {}

  @Get('weight')
  @ApiOperation({ summary: 'Weight history, with the trend through it' })
  series(
    @CurrentUser('sub') userId: string,
    @Query() query: WeightSeriesQueryDto,
  ): Promise<WeightSeries> {
    return this.weight.series(userId, query.days);
  }

  /**
   * Returns the whole series, not the point that was written.
   *
   * The screen that posts this is a chart, and every figure on it moves when a
   * reading lands — the trend, the delta, the current weight. Returning the
   * point would have the client either recompute all of that or immediately GET
   * the series it just caused, and the second is a round trip for data the
   * server already has in hand.
   *
   * 200, not 201. The row is an upsert on (user, day): posting twice on a
   * Tuesday corrects Tuesday rather than creating anything, so there is no
   * consistent resource creation to report.
   */
  /**
   * Delete one reading, addressed by its day.
   *
   * Declared above `POST weight` only for readability; the paths do not
   * collide. Returns the series rather than 204, for the reason the POST does:
   * every figure on the screen moves when a reading leaves, and a 204 would
   * cost a round trip to learn what they became.
   *
   * 409 when it is the only reading there is — see `WeightService.remove`.
   */
  @Delete('weight/:date')
  @ApiOperation({ summary: 'Delete one reading' })
  remove(
    @CurrentUser('sub') userId: string,
    @Param() params: WeightDateParamDto,
    @Query() query: WeightSeriesQueryDto,
  ): Promise<WeightSeries> {
    return this.weight.remove(userId, params.date, query.days);
  }

  @Post('weight')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record a weight, and recompute targets from it" })
  log(
    @CurrentUser('sub') userId: string,
    @Body() body: LogWeightDto,
    @Query() query: WeightSeriesQueryDto,
  ): Promise<WeightSeries> {
    return this.weight.log(userId, body, query.days);
  }
}
