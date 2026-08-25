import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { AccessTokenClaims } from '@nutricheck/contracts';
import type { FastifyRequest } from 'fastify';
import { QuotaExhaustedException } from '../../common/problems';
import { QuotaService } from './quota.service';

/**
 * Applied to the resolver route only.
 *
 * When it rejects, search and the repeat strip keep working — the app never
 * fully stops, it degrades to the routes that cannot fail.
 */
@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(private readonly quota: QuotaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & { user?: AccessTokenClaims }
    >();
    const userId = request.user?.sub;
    if (!userId) return true; // JwtAuthGuard has already rejected this

    const status = await this.quota.status(userId);
    if (status.blocked) throw new QuotaExhaustedException(status.resetAt);

    return true;
  }
}
