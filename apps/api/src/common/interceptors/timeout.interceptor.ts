import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { throwError, TimeoutError, type Observable } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { ResolverTimeoutException } from '../problems';

/**
 * Per-module request ceiling.
 *
 * Applied to the resolver rather than globally: the AI route is the only one
 * that can hang on a third party, and a global timeout tuned for it would be
 * far too generous for the interactive routes.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly ms: number) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.ms),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError ? new ResolverTimeoutException() : error,
        ),
      ),
    );
  }
}
