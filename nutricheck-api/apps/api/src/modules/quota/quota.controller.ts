import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { QuotaService, type QuotaStatus } from './quota.service';

@ApiTags('quota')
@Controller({ path: 'quota', version: '1' })
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  /** So the composer can warn before the user types, not after. */
  @Get()
  @ApiOperation({ summary: 'Remaining AI resolves and when they reset' })
  async status(@CurrentUser('sub') userId: string): Promise<QuotaStatus> {
    return this.quota.status(userId);
  }
}
