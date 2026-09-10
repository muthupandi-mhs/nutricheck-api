import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { StarsResponse } from '@nutricheck/contracts';
import { StarsService } from './stars.service';

/**
 * Read-only, and open to any signed-in user — who appears here is decided
 * entirely on the admin side, never by the caller.
 */
@ApiTags('me')
@Controller({ path: 'me/stars', version: '1' })
export class StarsController {
  constructor(private readonly stars: StarsService) {}

  @Get()
  @ApiOperation({ summary: 'The admin-curated Stars leaderboard' })
  list(): Promise<StarsResponse> {
    return this.stars.list();
  }
}
