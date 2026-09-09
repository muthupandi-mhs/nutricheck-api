import { LocalDate, LogSteps, StepsQuery } from '@nutricheck/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';

export class LogStepsDto extends createZodDto(LogSteps) {}
export class StepsQueryDto extends createZodDto(StepsQuery) {}

/**
 * The day in the path. Validated rather than taken as a string, so a malformed
 * date is a 422 naming the field instead of a query that quietly matches
 * nothing and 404s.
 */
export class StepsDateParamDto extends createZodDto(z.object({ date: LocalDate })) {}
