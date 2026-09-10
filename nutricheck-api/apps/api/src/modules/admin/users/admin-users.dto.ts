import { AdminPageQuery } from '@nutricheck/contracts';
import { createZodDto } from '../../../common/zod/zod-dto';

export class AdminUserListQueryDto extends createZodDto(AdminPageQuery) {}
