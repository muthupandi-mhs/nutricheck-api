import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AdminTokenClaims } from '@nutricheck/contracts';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/config.schema';
import { UnauthorizedProblem } from '../problems';

export interface AdminAuthenticatedRequest extends FastifyRequest {
  admin?: AdminTokenClaims;
}

/**
 * The admin app's equivalent of JwtAuthGuard, verifying against
 * `ADMIN_JWT_SECRET` instead of the app's `JWT_ACCESS_SECRET`.
 *
 * Not global, and not a `@Public()` exemption on the regular guard: every
 * admin controller is `@Public()` to JwtAuthGuard (an app-user token must not
 * satisfy it) and separately carries `@UseGuards(AdminAuthGuard)`. Two guards,
 * two keys, no path where one token type authenticates the other's routes.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedProblem('Missing bearer token');
    }

    try {
      const claims = await this.jwt.verifyAsync<AdminTokenClaims>(header.slice('Bearer '.length), {
        secret: this.config.get('ADMIN_JWT_SECRET', { infer: true }),
      });
      request.admin = claims;
      return true;
    } catch {
      throw new UnauthorizedProblem('Access token is invalid or expired');
    }
  }
}
