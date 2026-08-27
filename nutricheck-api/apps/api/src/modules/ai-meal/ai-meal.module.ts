import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { FoodsModule } from '../foods/foods.module';
import { QuotaModule } from '../quota/quota.module';
import { AiMealController } from './ai-meal.controller';
import { AiMealService } from './ai-meal.service';

/**
 * The corpus-free meal path. Sits beside ResolverModule rather than inside it:
 * the two share dependencies but answer opposite questions, and folding this
 * into the resolver would make "did this number come from a measurement"
 * depend on a branch rather than on which route was called.
 */
@Module({
  imports: [AiModule, FoodsModule, QuotaModule],
  controllers: [AiMealController],
  providers: [AiMealService],
  exports: [AiMealService],
})
export class AiMealModule {}
