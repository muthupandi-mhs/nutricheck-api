import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FeedbackList } from '@nutricheck/contracts';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { FeedbackService } from '../../feedback/feedback.service';

/**
 * The admin app's view of the QA feedback tab — same data as
 * FeedbackController.list, behind AdminAuthGuard instead of an app-user
 * token. The app's own `/v1/feedback` stays as-is; see its doc comment for
 * why it is not locked down further.
 */
@Public()
@UseGuards(AdminAuthGuard)
@ApiTags('admin-feedback')
@Controller({ path: 'admin/feedback', version: '1' })
export class AdminFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  @ApiOperation({ summary: 'List every bug report and feature request filed so far' })
  list(): Promise<FeedbackList> {
    return this.feedback.list();
  }
}
