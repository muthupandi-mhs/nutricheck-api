import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FeedbackItem, FeedbackList } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SubmitFeedbackDto } from './feedback.dto';
import { FeedbackService } from './feedback.service';

/**
 * The QA feedback tab — filed by whoever is testing, reviewed by the team.
 *
 * No role check on GET. This is a temporary internal tool for a single test
 * pass, not a support inbox, and every account that can reach it is already
 * one of the people it exists for; building a review-role system for it would
 * outlive the tab itself. Remove this whole module when the tab comes out.
 */
@ApiTags('feedback')
@Controller({ path: 'feedback', version: '1' })
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post()
  @ApiOperation({ summary: 'File a bug report or feature request' })
  submit(@CurrentUser('sub') userId: string, @Body() body: SubmitFeedbackDto): Promise<FeedbackItem> {
    return this.feedback.submit(userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List every report filed so far, newest first' })
  list(): Promise<FeedbackList> {
    return this.feedback.list();
  }
}
