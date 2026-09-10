import { AdminLoginRequest } from '@nutricheck/contracts';
import { createZodDto } from '../../../common/zod/zod-dto';

export class AdminLoginDto extends createZodDto(AdminLoginRequest) {}
