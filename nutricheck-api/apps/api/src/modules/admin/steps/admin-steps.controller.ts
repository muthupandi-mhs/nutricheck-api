import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminStepsListResponse } from '@nutricheck/contracts';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { AdminStepsListQueryDto } from './admin-steps.dto';
import { AdminStepsService } from './admin-steps.service';

@Public()
@UseGuards(AdminAuthGuard)
@ApiTags('admin-steps')
@Controller({ path: 'admin/steps', version: '1' })
export class AdminStepsController {
  constructor(private readonly steps: AdminStepsService) {}

  @Get()
  @ApiOperation({ summary: 'Every user ranked by all-time step total, searchable by name or email' })
  list(@Query() query: AdminStepsListQueryDto): Promise<AdminStepsListResponse> {
    return this.steps.list(query);
  }
}
