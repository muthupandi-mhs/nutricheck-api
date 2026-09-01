import { Module } from '@nestjs/common';
import { GoalsModule } from '../goals/goals.module';
import { WeightController } from './weight.controller';
import { WeightService } from './weight.service';

/**
 * Depends on GoalsModule in one direction only, and that is a deliberate
 * shape rather than an accident of who was written first.
 *
 * A weight is an input to the goal formula, so recording one has to recompute
 * the targets — this module needs GoalsService. The reverse write, a profile
 * save appending a weight row, happens inside `GoalsService.upsertProfile`
 * against the table directly rather than by calling back into WeightService.
 * That keeps it in the same transaction as the profile write, and keeps the
 * two modules from importing each other.
 */
@Module({
  imports: [GoalsModule],
  controllers: [WeightController],
  providers: [WeightService],
  exports: [WeightService],
})
export class WeightModule {}
