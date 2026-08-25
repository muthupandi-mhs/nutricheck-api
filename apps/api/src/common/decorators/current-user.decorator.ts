import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessTokenClaims } from '@nutricheck/contracts';

export interface AuthenticatedRequest {
  user?: AccessTokenClaims;
}

/**
 * The authenticated principal, populated by JwtAuthGuard.
 *
 * Non-null by construction: the guard runs first and rejects the request when
 * there are no claims, so any handler that can read this has already passed it.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AccessTokenClaims | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user as AccessTokenClaims;
    return field ? user[field] : user;
  },
);
