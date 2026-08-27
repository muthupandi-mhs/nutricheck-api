import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { QuotaModule } from '../quota/quota.module';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { SuggestedTargetsService } from './suggested-targets.service';

@Module({
  imports: [AiModule, QuotaModule],
  controllers: [GoalsController],
  providers: [GoalsService, SuggestedTargetsService],
  // LogsModule needs goalInEffect() to resolve a day view against the goal that
  // applied on that date rather than the current one.
  exports: [GoalsService],
})
export class GoalsModule {}
