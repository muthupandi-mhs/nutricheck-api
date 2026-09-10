import { z } from 'zod';
import { createZodDto } from '../../../common/zod/zod-dto';

export class AdminGroupListQueryDto extends createZodDto(z.object({ q: z.string().trim().max(200).optional() })) {}
