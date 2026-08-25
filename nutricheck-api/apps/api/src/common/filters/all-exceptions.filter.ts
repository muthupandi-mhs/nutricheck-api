import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  PROBLEM_BASE_URI,
  PROBLEM_TYPES,
  type ProblemDetails,
  type ProblemType,
} from '@nutricheck/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemException } from '../problems';

/**
 * The one place an error becomes a response body.
 *
 * Three rules:
 *   1. Every error serializes as application/problem+json (RFC 9457).
 *   2. An unrecognized error is a 500 whose message is REPLACED — the original
 *      is logged with its stack, never sent. Internal detail leaks are how
 *      stack traces end up in a mobile app's error toast.
 *   3. 5xx logs at error, 4xx at debug. A validation failure is the client's
 *      problem, not an incident, and paging on them trains people to ignore logs.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const problem = this.toProblem(exception, request);

    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, requestId: problem.requestId, path: problem.instance },
        `${problem.status} ${problem.title}`,
      );
    } else {
      this.logger.debug(
        { requestId: problem.requestId, path: problem.instance },
        `${problem.status} ${problem.title}`,
      );
    }

    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send(problem);
  }

  private toProblem(exception: unknown, request: FastifyRequest): ProblemDetails {
    const base = {
      instance: request.url,
      requestId: request.id as string | undefined,
    };

    if (exception instanceof ProblemException) {
      const { type, title, status, detail, extensions } = exception.problem;
      return {
        type: PROBLEM_BASE_URI + type,
        title,
        status,
        ...(detail ? { detail } : {}),
        ...base,
        ...extensions,
      } as ProblemDetails;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail =
        typeof response === 'string'
          ? response
          : ((response as Record<string, unknown>)?.message as string | undefined);

      return {
        type: PROBLEM_BASE_URI + this.typeForStatus(status),
        title: exception.name.replace(/Exception$/, ''),
        status,
        ...(detail && status < 500 ? { detail } : {}),
        ...base,
      };
    }

    return {
      type: PROBLEM_BASE_URI + PROBLEM_TYPES.internal,
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      ...base,
    };
  }

  private typeForStatus(status: number): ProblemType {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return PROBLEM_TYPES.unauthorized;
      case HttpStatus.FORBIDDEN:
        return PROBLEM_TYPES.forbidden;
      case HttpStatus.NOT_FOUND:
        return PROBLEM_TYPES.notFound;
      case HttpStatus.CONFLICT:
        return PROBLEM_TYPES.conflict;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return PROBLEM_TYPES.validationFailed;
      case HttpStatus.TOO_MANY_REQUESTS:
        return PROBLEM_TYPES.rateLimited;
      default:
        return status >= 500 ? PROBLEM_TYPES.internal : PROBLEM_TYPES.validationFailed;
    }
  }
}
