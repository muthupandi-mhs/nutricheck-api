import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { StepsCampaignResponse } from '@nutricheck/contracts';
import { CampaignService } from './campaign.service';

/**
 * On `me`, beside steps, groups and stars — same reasoning as `GET me/stars`:
 * nothing here is personal to the caller, it just lives behind the same auth
 * every other `/me` route does rather than opening a new unauthenticated
 * surface for one banner.
 */
@ApiTags('me')
@Controller({ path: 'me/steps/campaign', version: '1' })
export class CampaignController {
  constructor(private readonly campaign: CampaignService) {}

  @Get()
  @ApiOperation({ summary: 'The Steps screen banner, or null if no admin has configured one' })
  async current(): Promise<StepsCampaignResponse> {
    return { campaign: await this.campaign.current() };
  }
}
