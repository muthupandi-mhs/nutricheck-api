import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminGroupListResponse } from '@nutricheck/contracts';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { AdminGroupListQueryDto } from './admin-groups.dto';
import { AdminGroupsService } from './admin-groups.service';

@Public()
@UseGuards(AdminAuthGuard)
@ApiTags('admin-groups')
@Controller({ path: 'admin/groups', version: '1' })
export class AdminGroupsController {
  constructor(private readonly groups: AdminGroupsService) {}

  @Get()
  @ApiOperation({ summary: 'Search groups by name, to pick one for the campaign banner' })
  list(@Query() query: AdminGroupListQueryDto): Promise<AdminGroupListResponse> {
    return this.groups.list(query.q);
  }
}
