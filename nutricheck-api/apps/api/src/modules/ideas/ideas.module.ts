import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { FoodsModule } from '../foods/foods.module';
import { GoalsModule } from '../goals/goals.module';
import { LogsModule } from '../logs/logs.module';
import { QuotaModule } from '../quota/quota.module';
import { IdeasController } from './ideas.controller';
import { IdeasService } from './ideas.service';

/**
 * The food-ideas tab.
 *
 * Depends on LogsModule rather than the database for the same reason
 * InsightsModule does: the gap it suggests against is computed from the day
 * view the Today screen renders, so the two cannot disagree about a total. It
 * takes FoodsModule because an idea has to become a real row before the portion
 * screen can open on it, and QuotaModule because this is a billed model call
 * that fires on navigation rather than on a question.
 */
@Module({
  imports: [AiModule, FoodsModule, GoalsModule, LogsModule, QuotaModule],
  controllers: [IdeasController],
  providers: [IdeasService],
  exports: [IdeasService],
})
export class IdeasModule {}
