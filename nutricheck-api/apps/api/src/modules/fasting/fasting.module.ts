import { Module } from '@nestjs/common';
import { FastingController } from './fasting.controller';
import { FastingService } from './fasting.service';

/**
 * No imports, and that is the design rather than a stage it has not reached.
 *
 * `WeightModule` depends on `GoalsModule` because a weight is an input to the
 * goal formula, so recording one has to recompute the targets. A fast changes
 * no target and moves no figure on any other screen, so nothing has to be
 * recomputed when one starts, ends or is deleted.
 *
 * **It does now feed one prompt, and the arrow still only points one way.**
 * `IdeasService` imports this module to ask what somebody's eating window is
 * before suggesting food for it — see `IdeasModule`. Nothing here knows that,
 * and nothing here should: the suggestion path reads a summary, and a user who
 * deletes their entire fasting history simply gets a list built without one.
 * That is why there is still no "you cannot delete the last one" rule in
 * `FastingService.remove`, and why there must not be.
 */
@Module({
  controllers: [FastingController],
  providers: [FastingService],
  exports: [FastingService],
})
export class FastingModule {}
