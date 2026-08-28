import {
  CommitLogBatch,
  CommitLogEntry,
  DayQuery,
  MonthQuery,
  UpdateLogEntry,
  UpdateLogItem,
  WeekQuery,
} from '@nutricheck/contracts';
import { createZodDto } from '../../common/zod/zod-dto';

export class CommitLogEntryDto extends createZodDto(CommitLogEntry) {}
export class CommitLogBatchDto extends createZodDto(CommitLogBatch) {}
export class DayQueryDto extends createZodDto(DayQuery) {}
export class WeekQueryDto extends createZodDto(WeekQuery) {}
export class MonthQueryDto extends createZodDto(MonthQuery) {}
export class UpdateLogEntryDto extends createZodDto(UpdateLogEntry) {}
export class UpdateLogItemDto extends createZodDto(UpdateLogItem) {}
