import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminUserDetail, AdminUserListResponse } from '@nutricheck/contracts';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { AdminUserListQueryDto } from './admin-users.dto';
import { AdminUsersService } from './admin-users.service';

@Public()
@UseGuards(AdminAuthGuard)
@ApiTags('admin-users')
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'Search and list app accounts' })
  list(@Query() query: AdminUserListQueryDto): Promise<AdminUserListResponse> {
    return this.users.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One account: profile, latest goal, and activity counts' })
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<AdminUserDetail> {
    return this.users.detail(id);
  }

  @Post(':id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete the account — same 30-day grace window as self-service delete' })
  softDelete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.users.softDelete(id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Undo a soft-delete within the grace window' })
  restore(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.users.restore(id);
  }
}
