import { Module } from '@nestjs/common';
import { StepsController } from './steps.controller';
import { StepsService } from './steps.service';

/**
 * No `imports`, unlike `WeightModule` — steps don't feed the goal calculator
 * or anything else, so there is nothing else this module needs.
 */
@Module({
  controllers: [StepsController],
  providers: [StepsService],
  exports: [StepsService],
})
export class StepsModule {}
