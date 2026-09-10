import { Module } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

@Module({
  controllers: [FeedbackController],
  providers: [FeedbackService],
  // The admin app's read-only view reuses this service rather than duplicating
  // the reporter-label join.
  exports: [FeedbackService],
})
export class FeedbackModule {}
