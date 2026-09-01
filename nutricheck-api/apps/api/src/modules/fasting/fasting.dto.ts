import {
  AdjustFast,
  EndFast,
  FastingHistoryQuery,
  StartFast,
} from '@nutricheck/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';

export class StartFastDto extends createZodDto(StartFast) {}
export class AdjustFastDto extends createZodDto(AdjustFast) {}
export class EndFastDto extends createZodDto(EndFast) {}
export class FastingHistoryQueryDto extends createZodDto(FastingHistoryQuery) {}

/**
 * The id in the path. Validated rather than taken as a string, so a malformed
 * id is a 422 naming the field instead of a query that hands Postgres a
 * non-uuid and fails as a 500 about invalid input syntax.
 */
export class FastIdParamDto extends createZodDto(z.object({ id: z.string().uuid() })) {}
