import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AdminAuthResponse, AdminSessionUser } from '@nutricheck/contracts';
import { CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { AdminAuthGuard } from '../../../common/guards/admin-auth.guard';
import { ProblemThrottlerGuard } from '../../../common/guards/problem-throttler.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './admin-auth.dto';

/**
 * `@Public()` at class level so JwtAuthGuard — global, fail-closed — skips
 * every route here rather than demanding an app-user bearer token. `login` is
 * then unauthenticated by nature and `me` is protected separately by
 * AdminAuthGuard, keyed on `ADMIN_JWT_SECRET`. The two guards never overlap.
 */
@Public()
@ApiTags('admin-auth')
@Controller({ path: 'admin/auth', version: '1' })
@UseGuards(ProblemThrottlerGuard)
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Generous enough for a mistyped password or two, tight enough that
  // credential stuffing against the one door into every user's data does not
  // get a budget worth automating.
  @Throttle({ default: { ttl: 600_000, limit: 10 } })
  @ApiOperation({ summary: 'Sign in to the admin app' })
  login(@Body() body: AdminLoginDto): Promise<AdminAuthResponse> {
    return this.adminAuth.login(body);
  }

  @UseGuards(AdminAuthGuard)
  @Get('me')
  @ApiOperation({ summary: 'The signed-in admin' })
  me(@CurrentAdmin('sub') adminId: string): Promise<AdminSessionUser> {
    return this.adminAuth.me(adminId);
  }
}
