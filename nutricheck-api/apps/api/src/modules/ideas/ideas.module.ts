import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { FastingModule } from '../fasting/fasting.module';
import { FoodsModule } from '../foods/foods.module';
import { GoalsModule } from '../goals/goals.module';
import { LogsModule } from '../logs/logs.module';
import { QuotaModule } from '../quota/quota.module';
import { WeightModule } from '../weight/weight.module';
import { IdeasController } from './ideas.controller';
import { IdeasService } from './ideas.service';

/**
 * The food-ideas tab.
 *
 * Depends on LogsModule rather than the database for the same reason
 * InsightsModule does: the gap it suggests against is computed from the day
 * view the Home screen renders, so the two cannot disagree about a total. It
 * takes FoodsModule because an idea has to become a real row before the portion
 * screen can open on it, and QuotaModule because this is a billed model call
 * that fires on navigation rather than on a question.
 *
 * FastingModule and WeightModule are here for the same reason and are read the
 * same way — through the services that already answer those screens, never
 * against `fasting_sessions` or `weight_logs` directly. A suggestion that
 * reasoned from a slope this module fitted itself would eventually disagree
 * with the chart the user is looking at, and neither number would be wrong
 * enough to explain the other.
 *
 * The dependency runs one way only. Nothing in fasting or weight knows this
 * module exists, so deleting a fast or a weigh-in still costs nothing beyond
 * the next list being built without it.
 */
@Module({
  imports: [
    AiModule,
    FastingModule,
    FoodsModule,
    GoalsModule,
    LogsModule,
    QuotaModule,
    WeightModule,
  ],
  controllers: [IdeasController],
  providers: [IdeasService],
  exports: [IdeasService],
})
export class IdeasModule {}
