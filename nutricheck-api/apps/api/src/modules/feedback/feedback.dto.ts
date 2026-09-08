import { SubmitFeedbackRequest } from '@nutricheck/contracts';
import { createZodDto } from '../../common/zod/zod-dto';

export class SubmitFeedbackDto extends createZodDto(SubmitFeedbackRequest) {}
