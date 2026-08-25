import { Module } from '@nestjs/common';
import { LogsModule } from '../logs/logs.module';
import { MealsController } from './meals.controller';
import { MealsService } from './meals.service';

@Module({
  // Logging a saved meal reuses LogsService.commit rather than writing entries
  // itself, so there is exactly one code path that creates a log entry.
  imports: [LogsModule],
  controllers: [MealsController],
  providers: [MealsService],
  exports: [MealsService],
})
export class MealsModule {}
