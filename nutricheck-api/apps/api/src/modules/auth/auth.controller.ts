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
import {
  PROBLEM_TYPES,
  type AuthResponse,
  type CheckEmailResponse,
  type TokenPair,
} from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ProblemThrottlerGuard } from '../../common/guards/problem-throttler.guard';
import { ProblemException, UnauthorizedProblem } from '../../common/problems';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  CheckEmailDto,
  GoogleAuthDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
} from './auth.dto';
import {
  GoogleIdentityService,
  GoogleTokenInvalid,
  GoogleUnavailable,
} from './google-identity.service';

/**
 * Email + password, and Google.
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
/**
 * Ten minutes, for all three.
 *
 * The window is the part a blocked person actually feels. Whatever the count
 * is, being refused meant an hour of nothing on register — and the people most
 * likely to hit it are not abusing anything, they are the sixth person on a
 * carrier address who has done nothing but open the app.
 *
 * A shorter window does raise the sustained rate an attacker can hold from one
 * address, and that is the trade being made. It is worth it because per-IP
 * throttling was never what stops a determined attacker — they have as many
 * addresses as they want — it is what stops casual abuse and a client stuck in
 * a loop, and a ten-minute window stops both of those just as well.
 */
const WINDOW_MS = 600_000;

const REGISTER_PER_WINDOW = 30;
const LOGIN_PER_WINDOW = 30;

/**
 * Lower than the other two, because this one needs no password and so is the
 * fastest way to ask whether an address exists. Not as low as it was: at eight
 * it was the FIRST step of signing up, so a shared carrier address ran out of
 * them before anybody got as far as choosing a password.
 *
 * Enumeration is a volume attack. Twenty an address is useless for scanning a
 * list and plenty for a household.
 */
const CHECK_EMAIL_PER_WINDOW = 20;

/**
 * Authenticated, and still keyed on IP like the rest — which is the whole
 * reason this moved. Five a quarter-hour is generous for one person changing
 * their own password and nothing at all for a carrier address where the five
 * before them were strangers.
 */
const CHANGE_PASSWORD_PER_WINDOW = 15;

/**
 * Google sign-in, and the most generous of the four, on purpose.
 *
 * There is no password to guess here and nothing to enumerate: a request either
 * carries a token Google signed for this app or it does not, and no amount of
 * volume improves an attacker's odds of producing one. What the limit is
 * actually for is a client stuck in a retry loop and the JWKS amplification
 * described in `GoogleIdentityService` — and the same carrier-NAT reasoning
 * above applies with more force, because this is the one-tap path a whole
 * household will take.
 */
const GOOGLE_PER_WINDOW = 60;

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
@UseGuards(ProblemThrottlerGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleIdentityService,
  ) {}

  @Public()
  @Post('check-email')
  @HttpCode(HttpStatus.OK)
  // Tighter than login and register. This one needs no password, so a
  // permissive limit would turn it into a fast enumeration oracle -- the
  // volume is the part worth denying, not the single answer.
  @Throttle({ default: { ttl: WINDOW_MS, limit: CHECK_EMAIL_PER_WINDOW } })
  @ApiOperation({ summary: 'Whether an address already has an account' })
  checkEmail(@Body() body: CheckEmailDto): Promise<CheckEmailResponse> {
    return this.auth.checkEmail(body.email);
  }

  @Public()
  @Post('register')
  @Throttle({ default: { ttl: WINDOW_MS, limit: REGISTER_PER_WINDOW } })
  @ApiOperation({ summary: 'Create an account and sign in' })
  register(@Body() body: RegisterDto): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: WINDOW_MS, limit: LOGIN_PER_WINDOW } })
  @ApiOperation({ summary: 'Sign in with email and password' })
  login(@Body() body: LoginDto): Promise<AuthResponse> {
    return this.auth.login(body);
  }

  /**
   * One route, not two. Google already knows whether this person has an
   * account, so there is no `check-email` step and no `registered` flag to
   * carry forward — the server decides between signing in, linking to an
   * existing password account, and creating a new one, from a token it
   * verified. See `AuthService.resolveGoogleUser`.
   */
  @Public()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: WINDOW_MS, limit: GOOGLE_PER_WINDOW } })
  @ApiOperation({ summary: 'Sign in with a Google ID token' })
  async signInWithGoogle(@Body() body: GoogleAuthDto): Promise<AuthResponse> {
    if (!this.google.isConfigured) {
      // No client IDs configured: the button should not have been shown, but a
      // stale build will still press it. Same degradation as the resolver and
      // transcription without a key — absent, not broken.
      throw new ProblemException({
        type: PROBLEM_TYPES.resolverUnavailable,
        title: 'Google sign-in is unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'Sign in with an email and password instead.',
      });
    }

    try {
      return await this.auth.signInWithGoogle(body.idToken);
    } catch (error) {
      /**
       * Every rejected token is one 401 with one message. Which of the five
       * checks failed is diagnostic gold for somebody probing the endpoint and
       * of no use whatsoever to the phone — it has one thing it can do about
       * any of them, which is ask Google for a fresh token.
       */
      if (error instanceof GoogleTokenInvalid) {
        throw new UnauthorizedProblem('Could not verify that Google sign-in');
      }
      /**
       * Google unreachable is OUR outage to report, not the user's account
       * being refused. A 401 here would sign them out and send them to a
       * password screen for an account that may not have a password.
       */
      if (error instanceof GoogleUnavailable) {
        throw new ProblemException({
          type: PROBLEM_TYPES.resolverUnavailable,
          title: 'Could not reach Google',
          status: HttpStatus.SERVICE_UNAVAILABLE,
          detail: 'Try again in a moment.',
        });
      }
      throw error;
    }
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
  @Throttle({ default: { ttl: WINDOW_MS, limit: CHANGE_PASSWORD_PER_WINDOW } })
  @ApiOperation({ summary: 'Change the password and sign out every other device' })
  async changePassword(
    @CurrentUser('sub') userId: string,
    @CurrentUser('sid') currentFamilyId: string,
    @Body() body: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(userId, body, currentFamilyId);
  }
}
