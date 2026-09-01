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
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  BatchCommitResult,
  DaySummary,
  LogEntry,
  MonthSummary,
  WeekSummary,
} from '@nutricheck/contracts';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  CommitLogBatchDto,
  CommitLogEntryDto,
  DayQueryDto,
  UpdateLogEntryDto,
  UpdateLogItemDto,
  WeekQueryDto,
  MonthQueryDto,
} from './logs.dto';
import { LogsService } from './logs.service';

@ApiTags('logs')
@Controller({ path: 'logs', version: '1' })
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  /**
   * 201 when the entry was created, 200 when this clientId was already
   * committed. The distinction matters to an offline queue deciding whether it
   * still has work to do; the body is identical either way.
   */
  @Post()
  @ApiOperation({ summary: 'Commit an entry (idempotent on clientId)' })
  async commit(
    @CurrentUser('sub') userId: string,
    @Body() body: CommitLogEntryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LogEntry> {
    const { entry, created } = await this.logs.commit(userId, body);
    void reply.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return entry;
  }

  /**
   * Always 200. A drained queue reports per element, so one bad entry does not
   * cost the user the other eleven.
   */
  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Drain an offline queue' })
  commitBatch(
    @CurrentUser('sub') userId: string,
    @Body() body: CommitLogBatchDto,
  ): Promise<BatchCommitResult[]> {
    return this.logs.commitBatch(userId, body.entries);
  }

  @Get('day')
  @ApiOperation({ summary: 'A day with totals and the goal in effect on it' })
  day(
    @CurrentUser('sub') userId: string,
    @Query() query: DayQueryDto,
  ): Promise<DaySummary> {
    return this.logs.day(userId, query.date, query.tz);
  }

  /**
   * Declared before `GET :id` deliberately. Nest matches in declaration order,
   * so a `:id` route above this one would swallow `/week` and fail it as a
   * malformed uuid — the same reason `day` sits where it does.
   */
  @Get('week')
  @ApiOperation({ summary: 'Seven days ending on a date, with averages and the streak' })
  week(
    @CurrentUser('sub') userId: string,
    @Query() query: WeekQueryDto,
  ): Promise<WeekSummary> {
    return this.logs.week(userId, query.date, query.tz);
  }

  /**
   * A whole calendar month, one point per day — the history calendar behind
   * Home's masthead.
   *
   * Above `GET :id` for the same reason `day` and `week` are: Nest matches in
   * declaration order, and a `:id` route ahead of this would swallow `/month`
   * and reject it as a malformed uuid.
   */
  @Get('month')
  @ApiOperation({ summary: 'Every day of one calendar month, logged or not' })
  month(
    @CurrentUser('sub') userId: string,
    @Query() query: MonthQueryDto,
  ): Promise<MonthSummary> {
    return this.logs.month(userId, query.date, query.tz);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One entry' })
  getById(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LogEntry> {
    return this.logs.getById(userId, id);
  }

  /** Items are replaced wholesale and re-frozen from the corpus. */
  @Patch(':id')
  @ApiOperation({ summary: 'Edit an entry' })
  update(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLogEntryDto,
  ): Promise<LogEntry> {
    return this.logs.update(userId, id, body);
  }

  /**
   * One portion, addressed by item id. Declared after `PATCH :id` for
   * readability; the two do not collide because this path has three segments.
   *
   * Returns the whole entry rather than the item: the day view re-renders a
   * meal's totals, and a lone item would make the client do the arithmetic
   * the server just did.
   */
  @Patch(':id/items/:itemId')
  @ApiOperation({ summary: "Change one item's portion, and learn it" })
  updateItem(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: UpdateLogItemDto,
  ): Promise<LogEntry> {
    return this.logs.updateItem(userId, id, itemId, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an entry' })
  remove(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.logs.remove(userId, id);
  }
}
