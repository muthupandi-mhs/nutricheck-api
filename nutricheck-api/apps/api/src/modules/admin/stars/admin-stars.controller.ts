import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminStarsResponse } from '@nutricheck/contracts';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { AdminAddStarDto } from './admin-stars.dto';
import { AdminStarsService } from './admin-stars.service';

/**
 * Who appears on the public Stars leaderboard. Adding someone is a search
 * against the existing `GET /admin/users` list, not a search built here —
 * see `AdminUsersController`.
 */
@Public()
@UseGuards(AdminAuthGuard)
@ApiTags('admin-stars')
@Controller({ path: 'admin/stars', version: '1' })
export class AdminStarsController {
  constructor(private readonly stars: AdminStarsService) {}

  @Get()
  @ApiOperation({ summary: 'Everyone currently featured on the Stars leaderboard' })
  list(): Promise<AdminStarsResponse> {
    return this.stars.list();
  }

  @Post()
  @ApiOperation({ summary: 'Feature a user' })
  add(@CurrentAdmin('sub') adminId: string, @Body() body: AdminAddStarDto): Promise<void> {
    return this.stars.add(adminId, body.userId);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Un-feature a user' })
  remove(@Param('userId', ParseUUIDPipe) userId: string): Promise<void> {
    return this.stars.remove(userId);
  }
}
