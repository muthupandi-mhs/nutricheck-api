import { CreateGroup, JoinGroup } from '@nutricheck/contracts';
import { z } from 'zod';
import { createZodDto } from '../../common/zod/zod-dto';

export class CreateGroupDto extends createZodDto(CreateGroup) {}
export class JoinGroupDto extends createZodDto(JoinGroup) {}

/** The group in the path, validated rather than taken as a bare string. */
export class GroupIdParamDto extends createZodDto(z.object({ id: z.string().uuid() })) {}
