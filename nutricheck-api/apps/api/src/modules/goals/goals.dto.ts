import { SetGoal, UpdateUserProfile } from '@nutricheck/contracts';
import { createZodDto } from '../../common/zod/zod-dto';

export class UpdateProfileDto extends createZodDto(UpdateUserProfile) {}
export class SetGoalDto extends createZodDto(SetGoal) {}
