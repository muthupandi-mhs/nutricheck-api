import { SetGoal, UpdateUserProfile, UserProfile } from '@nutricheck/contracts';
import { createZodDto } from '../../common/zod/zod-dto';

export class UpdateProfileDto extends createZodDto(UpdateUserProfile) {}
export class SetGoalDto extends createZodDto(SetGoal) {}

/**
 * A preview takes the WHOLE profile, not a patch: the screen is asking "what
 * would my targets be for this profile", and a partial one has no answer.
 */
export class PreviewGoalDto extends createZodDto(UserProfile) {}
