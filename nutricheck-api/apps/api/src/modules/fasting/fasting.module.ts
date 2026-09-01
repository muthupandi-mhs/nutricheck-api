import { Module } from '@nestjs/common';
import { FastingController } from './fasting.controller';
import { FastingService } from './fasting.service';

/**
 * No imports, and that is the design rather than a stage it has not reached.
 *
 * `WeightModule` depends on `GoalsModule` because a weight is an input to the
 * goal formula, so recording one has to recompute the targets. Nothing is
 * derived from a fast: it changes no target, feeds no prompt, and moves no
 * figure on any other screen. That independence is what lets a user delete
 * their entire fasting history without anything else in the app noticing —
 * see `FastingService.remove`, which is why there is no "you cannot delete
 * the last one" rule here.
 */
@Module({
  controllers: [FastingController],
  providers: [FastingService],
  exports: [FastingService],
})
export class FastingModule {}
