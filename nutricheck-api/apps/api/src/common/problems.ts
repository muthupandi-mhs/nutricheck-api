import { HttpException, HttpStatus } from '@nestjs/common';
import { PROBLEM_TYPES, type ProblemType } from '@nutricheck/contracts';

export interface ProblemOptions {
  type: ProblemType;
  title: string;
  status: HttpStatus;
  detail?: string;
  /** Merged into the serialized problem document. Keys must not clash with RFC 9457 fields. */
  extensions?: Record<string, unknown>;
}

/**
 * The only exception type application code should throw.
 *
 * Controllers and services never build a response body; AllExceptionsFilter
 * turns this into the RFC 9457 document, adds `instance` and `requestId`, and
 * is the single place that decides what reaches the client.
 */
export class ProblemException extends HttpException {
  readonly problem: ProblemOptions;

  constructor(problem: ProblemOptions) {
    super(problem.title, problem.status);
    this.problem = problem;
  }
}

export class ValidationFailedException extends ProblemException {
  constructor(violations: Array<{ path: string; message: string }>) {
    super({
      type: PROBLEM_TYPES.validationFailed,
      title: 'Request validation failed',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      detail: `${violations.length} field${violations.length === 1 ? '' : 's'} rejected`,
      extensions: { violations },
    });
  }
}

export class NotFoundProblem extends ProblemException {
  constructor(resource: string) {
    super({
      type: PROBLEM_TYPES.notFound,
      title: `${resource} not found`,
      status: HttpStatus.NOT_FOUND,
    });
  }
}

export class UnauthorizedProblem extends ProblemException {
  constructor(detail = 'Authentication required') {
    super({
      type: PROBLEM_TYPES.unauthorized,
      title: 'Unauthorized',
      status: HttpStatus.UNAUTHORIZED,
      detail,
    });
  }
}

/**
 * Search and repeat keep working when this is thrown — the app never fully
 * stops (USER-FLOWS §8), which is why quota is enforced on one route only.
 */
export class QuotaExhaustedException extends ProblemException {
  constructor(resetAt: Date) {
    super({
      type: PROBLEM_TYPES.quotaExhausted,
      title: 'AI resolve quota exhausted',
      status: HttpStatus.TOO_MANY_REQUESTS,
      detail: 'Daily resolve limit reached. Search and repeat remain available.',
      extensions: { resetAt: resetAt.toISOString() },
    });
  }
}

export class ResolverTimeoutException extends ProblemException {
  constructor() {
    super({
      type: PROBLEM_TYPES.resolverTimeout,
      title: 'Could not read that in time',
      status: HttpStatus.GATEWAY_TIMEOUT,
      detail: 'The phrase is kept — search is pre-filled with it.',
    });
  }
}

export class ResolverUnavailableException extends ProblemException {
  constructor() {
    super({
      type: PROBLEM_TYPES.resolverUnavailable,
      title: 'Text logging is temporarily unavailable',
      status: HttpStatus.SERVICE_UNAVAILABLE,
      detail: 'Search and repeat still work.',
    });
  }
}
