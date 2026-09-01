import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { LogsModule } from '../logs/logs.module';
import { QuotaModule } from '../quota/quota.module';
import { WeightModule } from '../weight/weight.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

/**
 * Depends on LogsModule rather than the database: both the meal note and the
 * weekly review are computed from the same day and week views the screens
 * render, so the prose and the numbers above it cannot disagree about a total.
 *
 * WeightModule is read the same way and for the same reason — through the
 * service that already answers the weight chart, never against `weight_logs`
 * directly. A review reasoning from a slope this module fitted itself would
 * eventually disagree with the chart the user can open, and neither figure
 * would be wrong enough to explain the other. The dependency runs one way:
 * nothing in weight knows this module exists.
 *
 * QuotaModule arrived with the review. The meal note predates the ceiling and
 * still sits outside it, which is a real gap — see `mealInsight`, which records
 * its cost but does not check the allowance before spending it.
 */
@Module({
  imports: [AiModule, LogsModule, QuotaModule, WeightModule],
  controllers: [InsightsController],
  providers: [InsightsService],
  exports: [InsightsService],
})
export class InsightsModule {}
