import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { PROBLEM_TYPES } from '@nutricheck/contracts';
import { ProblemThrottlerGuard } from '../guards/problem-throttler.guard';
import { ProblemException } from '../problems';

/**
 * The sign-in and sign-up screens render `title` and `detail` verbatim into a
 * notice, and auth is the most heavily throttled surface in the API. These
 * assert the wording the user actually sees, not just the status code.
 */
describe('ProblemThrottlerGuard', () => {
  const guard = new ProblemThrottlerGuard(
    [] as never,
    {} as never,
    {} as never,
  );

  /** `throwThrottlingException` is protected; the guard exists to be subclassed. */
  const trip = (detail: Partial<ThrottlerLimitDetail>): Promise<void> =>
    (
      guard as unknown as {
        throwThrottlingException(
          context: ExecutionContext,
          detail: ThrottlerLimitDetail,
        ): Promise<void>;
      }
    ).throwThrottlingException({} as ExecutionContext, {
      limit: 10,
      ttl: 900_000,
      key: 'k',
      tracker: '203.0.113.1',
      totalHits: 11,
      timeToExpire: 0,
      isBlocked: true,
      timeToBlockExpire: 0,
      ...detail,
    } as ThrottlerLimitDetail);

  async function problem(detail: Partial<ThrottlerLimitDetail>) {
    const error = await trip(detail).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemException);
    return (error as ProblemException).problem;
  }

  it('is an RFC 9457 rate-limited problem, not a framework class name', async () => {
    const p = await problem({ timeToBlockExpire: 720 });

    expect(p.type).toBe(PROBLEM_TYPES.rateLimited);
    expect(p.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // The default ThrottlerException would surface as "Throttler" over
    // "ThrottlerException: Too Many Requests" — both shown to a real person.
    expect(p.title).toBe('Too many attempts');
    expect(p.detail).not.toMatch(/Throttler/);
  });

  it('says how long to wait, rounded up', async () => {
    expect((await problem({ timeToBlockExpire: 720 })).detail).toBe(
      'Wait 12 minutes and try again.',
    );
    // 11 minutes 1 second is not "11 minutes" — rounding down buys a second
    // rejection.
    expect((await problem({ timeToBlockExpire: 661 })).detail).toBe(
      'Wait 12 minutes and try again.',
    );
    expect((await problem({ timeToBlockExpire: 30 })).detail).toBe(
      'Wait a minute and try again.',
    );
    expect((await problem({ timeToBlockExpire: 3600 })).detail).toBe(
      'Wait an hour and try again.',
    );
  });

  it('carries resetAt, the contract’s 429-only field', async () => {
    const before = Date.now();
    const p = await problem({ timeToBlockExpire: 900 });
    const resetAt = Date.parse((p.extensions as { resetAt: string }).resetAt);

    expect(resetAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(resetAt).toBeLessThanOrEqual(Date.now() + 900_000);
  });

  it('falls back to the window when no block is in force', async () => {
    const p = await problem({
      isBlocked: false,
      timeToBlockExpire: -1,
      timeToExpire: 120,
    });
    expect(p.detail).toBe('Wait 2 minutes and try again.');
  });

  it('never tells anyone to wait zero', async () => {
    // Both fields round to 0 on the last tick of a window.
    const p = await problem({ timeToBlockExpire: 0, timeToExpire: 0 });
    expect(p.detail).toBe('Wait a minute and try again.');
  });
});
