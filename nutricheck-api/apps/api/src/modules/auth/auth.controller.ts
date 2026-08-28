import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthResponse, CheckEmailResponse, TokenPair } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ProblemThrottlerGuard } from '../../common/guards/problem-throttler.guard';
import { AuthService } from './auth.service';
import { ChangePasswordDto, CheckEmailDto, LoginDto, RefreshDto, RegisterDto } from './auth.dto';

/**
 * Email + password only.
 *
 * Throttled far harder than the rest of the API and keyed per IP: these are the
 * endpoints credential stuffing aims at, and the default 120/min would let an
 * attacker try 172,000 passwords a day from one address.
 */
/**
 * Per-IP limits on the two unauthenticated routes that can create or guess at
 * an account.
 *
 * They were 5 an hour and 10 a quarter of an hour, and both were too tight for
 * the market this is built for. The throttler keys on IP, and Indian mobile
 * carriers put thousands of subscribers behind one public address —
 * carrier-grade NAT is the norm, not the exception. At five registrations an
 * hour per IP, the sixth genuine person on a carrier is told to come back
 * later, and there is nothing they can do about it because the other five are
 * strangers.
 *
 * The numbers below are still low enough to make scripted bulk creation from
 * one address pointless, which is what the limit is for. What actually defends
 * the password is Argon2id and refresh-token reuse detection, neither of which
 * a shared IP weakens.
 */
const REGISTER_PER_HOUR = 30;
const LOGIN_PER_15_MIN = 30;

/**
 * Lower than the other two, because this one needs no password and so is the
 * fastest way to ask whether an address exists. Not as low as it was: at eight
 * a quarter-hour it was the FIRST step of signing up, so a shared carrier
 * address ran out of them before anybody got as far as choosing a password.
 *
 * Enumeration is a volume attack. Twenty an address is useless for scanning a
 * list and plenty for a household.
 */
const CHECK_EMAIL_PER_15_MIN = 20;

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
@UseGuards(ProblemThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('check-email')
  @HttpCode(HttpStatus.OK)
  // Tighter than login and register. This one needs no password, so a
  // permissive limit would turn it into a fast enumeration oracle -- the
  // volume is the part worth denying, not the single answer.
  @Throttle({ default: { ttl: 900_000, limit: CHECK_EMAIL_PER_15_MIN } })
  @ApiOperation({ summary: 'Whether an address already has an account' })
  checkEmail(@Body() body: CheckEmailDto): Promise<CheckEmailResponse> {
    return this.auth.checkEmail(body.email);
  }

  @Public()
  @Post('register')
  @Throttle({ default: { ttl: 3_600_000, limit: REGISTER_PER_HOUR } })
  @ApiOperation({ summary: 'Create an account and sign in' })
  register(@Body() body: RegisterDto): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 900_000, limit: LOGIN_PER_15_MIN } })
  @ApiOperation({ summary: 'Sign in with email and password' })
  login(@Body() body: LoginDto): Promise<AuthResponse> {
    return this.auth.login(body);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Rotate the refresh token and mint a new access token' })
  refresh(@Body() body: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken);
  }

  /**
   * Public because a client with an expired access token must still be able to
   * sign out. Possession of the refresh token is the authorization here.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke this session' })
  async logout(@Body() body: RefreshDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 900_000, limit: 5 } })
  @ApiOperation({ summary: 'Change the password and sign out every device' })
  async changePassword(
    @CurrentUser('sub') userId: string,
    @Body() body: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(userId, body);
  }
}
