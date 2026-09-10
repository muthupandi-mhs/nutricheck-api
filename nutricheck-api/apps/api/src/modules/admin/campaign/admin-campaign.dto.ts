import { AdminSetCampaign } from '@nutricheck/contracts';
import { createZodDto } from '../../../common/zod/zod-dto';

export class AdminSetCampaignDto extends createZodDto(AdminSetCampaign) {}
