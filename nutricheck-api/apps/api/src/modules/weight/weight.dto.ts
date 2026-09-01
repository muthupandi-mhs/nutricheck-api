import { LocalDate, LogWeight, WeightSeriesQuery } from '@nutricheck/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';

export class LogWeightDto extends createZodDto(LogWeight) {}
export class WeightSeriesQueryDto extends createZodDto(WeightSeriesQuery) {}

/**
 * The day in the path. Validated rather than taken as a string, so a malformed
 * date is a 422 naming the field instead of a query that quietly matches
 * nothing and 404s.
 */
export class WeightDateParamDto extends createZodDto(z.object({ date: LocalDate })) {}
