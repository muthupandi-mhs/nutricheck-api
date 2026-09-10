import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminDashboardStats } from '@nutricheck/contracts';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { AdminDashboardService } from './admin-dashboard.service';

@Public()
@UseGuards(AdminAuthGuard)
@ApiTags('admin-dashboard')
@Controller({ path: 'admin/dashboard', version: '1' })
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Headline counts for the admin home screen' })
  stats(): Promise<AdminDashboardStats> {
    return this.dashboard.stats();
  }
}
