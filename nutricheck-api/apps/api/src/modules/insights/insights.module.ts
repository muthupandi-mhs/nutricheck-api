import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { LogsModule } from '../logs/logs.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

/**
 * Depends on LogsModule rather than the database: the note is computed from the
 * same day view the screen renders, so the two cannot disagree about a total.
 */
@Module({
  imports: [LogsModule, AiModule],
  controllers: [InsightsController],
  providers: [InsightsService],
  exports: [InsightsService],
})
export class InsightsModule {}
