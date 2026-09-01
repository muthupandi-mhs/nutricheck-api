import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastingSummary } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  AdjustFastDto,
  EndFastDto,
  FastIdParamDto,
  FastingHistoryQueryDto,
  StartFastDto,
} from './fasting.dto';
import { FastingService } from './fasting.service';

/**
 * On `me`, beside the weight and the goals, for the same reason those are:
 * a fast is a fact about the user rather than a resource with a life of its
 * own. GoalsController, UsersController and WeightController already share
 * this prefix — Nest merges controllers on one path, and nothing here collides
 * with their routes.
 *
 * **Every route returns the whole summary, and none of them return the row
 * they touched.** The screen is a timer over a record over a history, and all
 * three move when a fast starts, ends or is thrown away: ending one changes
 * the average, the longest, the completed count and the list, none of which
 * are derivable from the row that changed. Returning the row would have the
 * client either recompute all of it or immediately GET what the server already
 * had in hand — the same reasoning as `WeightController`.
 *
 * 200 on the writes rather than 201, and no `Location` header, for a reason
 * that is specific to this shape: what comes back is not the thing that was
 * created. A 201 that points at a summary is a lie about what was made.
 */
@ApiTags('me')
@Controller({ path: 'me', version: '1' })
export class FastingController {
  constructor(private readonly fasting: FastingService) {}

  @Get('fasting')
  @ApiOperation({ summary: 'The running fast, the record, and recent history' })
  summary(
    @CurrentUser('sub') userId: string,
    @Query() query: FastingHistoryQueryDto,
  ): Promise<FastingSummary> {
    return this.fasting.summary(userId, query.limit);
  }

  /**
   * Start one. 409 when a fast is already running.
   *
   * The conflict is not something the client can fix by editing the body,
   * which is exactly what separates a 409 from a 422 here — there is no target
   * or start time that would make a second concurrent fast acceptable.
   */
  @Post('fasting')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a fast' })
  start(
    @CurrentUser('sub') userId: string,
    @Body() body: StartFastDto,
    @Query() query: FastingHistoryQueryDto,
  ): Promise<FastingSummary> {
    return this.fasting.start(userId, body, query.limit);
  }

  /**
   * Adjust the running fast — extend the target, correct the start, or both.
   *
   * `current` rather than an id, because there is only ever one and the client
   * should not have to name it. PATCH rather than PUT: the body carries the
   * fields being changed and omitting one means "leave it", which is what a
   * screen with two independent controls on it actually sends.
   */
  @Patch('fasting/current')
  @ApiOperation({ summary: 'Change the running fast without ending it' })
  adjust(
    @CurrentUser('sub') userId: string,
    @Body() body: AdjustFastDto,
    @Query() query: FastingHistoryQueryDto,
  ): Promise<FastingSummary> {
    return this.fasting.adjust(userId, body, query.limit);
  }

  /**
   * End it. 404 when nothing is running.
   *
   * A route of its own rather than `PATCH current { endedAt }`, because this
   * is the one state transition the record has and it should not look like a
   * field edit. It is also the only write here that must be safe to send
   * twice — see the `isNull` guard in `FastingService.end`.
   */
  @Post('fasting/current/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the running fast' })
  end(
    @CurrentUser('sub') userId: string,
    @Body() body: EndFastDto,
    @Query() query: FastingHistoryQueryDto,
  ): Promise<FastingSummary> {
    return this.fasting.end(userId, body, query.limit);
  }

  /**
   * Throw one away — the running one, or a finished one from the list.
   *
   * One route for both, because from the user's side they are one thing:
   * "this should not be in my history". Returns the summary rather than 204,
   * for the reason the writes above do.
   */
  @Delete('fasting/:id')
  @ApiOperation({ summary: 'Discard a fast, running or finished' })
  remove(
    @CurrentUser('sub') userId: string,
    @Param() params: FastIdParamDto,
    @Query() query: FastingHistoryQueryDto,
  ): Promise<FastingSummary> {
    return this.fasting.remove(userId, params.id, query.limit);
  }
}
