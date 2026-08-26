import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { RateLimitedException } from '../problems';

/**
 * The throttler, speaking RFC 9457.
 *
 * `ThrottlerGuard` throws a bare `HttpException` whose message is
 * "ThrottlerException: Too Many Requests". AllExceptionsFilter can only derive
 * a title from the class name for an exception it does not recognize, so that
 * reaches the app as `{ title: "Throttler", detail: "ThrottlerException: Too
 * Many Requests" }` — and the sign-in screen prints both verbatim.
 *
 * Auth is where throttling actually bites a real person (register is 5/hour per
 * IP, login 10 per 15 minutes), so this is the difference between a legible
 * "wait 12 minutes" and a framework class name shown to a user.
 */
@Injectable()
export class ProblemThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // Both fields are seconds. `timeToBlockExpire` is the one in force during a
    // block; the window's own remainder is the floor under it. The 1 guards the
    // final tick, where both can round to zero and "wait 0 minutes" is a lie.
    const seconds = Math.max(detail.timeToBlockExpire, detail.timeToExpire, 1);
    throw new RateLimitedException(seconds);
  }
}
