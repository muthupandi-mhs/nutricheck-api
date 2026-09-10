import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AdminTokenClaims } from '@nutricheck/contracts';
import type { AdminAuthenticatedRequest } from '../guards/admin-auth.guard';

/**
 * The authenticated admin principal, populated by AdminAuthGuard.
 *
 * Non-null by construction, same reasoning as `CurrentUser`: the guard runs
 * first and rejects the request when there are no claims.
 */
export const CurrentAdmin = createParamDecorator(
  (field: keyof AdminTokenClaims | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    const admin = request.admin as AdminTokenClaims;
    return field ? admin[field] : admin;
  },
);
