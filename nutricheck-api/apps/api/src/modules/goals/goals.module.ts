import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

@Module({
  controllers: [GoalsController],
  providers: [GoalsService],
  // LogsModule needs goalInEffect() to resolve a day view against the goal that
  // applied on that date rather than the current one.
  exports: [GoalsService],
})
export class GoalsModule {}
