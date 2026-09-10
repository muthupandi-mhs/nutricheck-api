import { AdminAddStar } from '@nutricheck/contracts';
import { createZodDto } from '../../../common/zod/zod-dto';

export class AdminAddStarDto extends createZodDto(AdminAddStar) {}
