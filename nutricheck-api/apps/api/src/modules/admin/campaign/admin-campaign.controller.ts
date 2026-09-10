import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminCampaignResponse } from '@nutricheck/contracts';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { CampaignService } from '../../campaign/campaign.service';
import { AdminSetCampaignDto } from './admin-campaign.dto';

/** Controls the same banner `CampaignController` serves — see `CampaignService`. */
@Public()
@UseGuards(AdminAuthGuard)
@ApiTags('admin-campaign')
@Controller({ path: 'admin/steps-campaign', version: '1' })
export class AdminCampaignController {
  constructor(private readonly campaign: CampaignService) {}

  @Get()
  @ApiOperation({ summary: 'The current banner config and its live totals' })
  view(): Promise<AdminCampaignResponse> {
    return this.campaign.adminView();
  }

  @Post()
  @ApiOperation({ summary: 'Set the banner — everyone, or one group, against a goal' })
  set(@CurrentAdmin('sub') adminId: string, @Body() body: AdminSetCampaignDto): Promise<void> {
    return this.campaign.set(adminId, body);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Turn the banner off' })
  clear(): Promise<void> {
    return this.campaign.clear();
  }
}
