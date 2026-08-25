import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedProblem } from '../problems';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TokenService } from '../../modules/auth/token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler first, then class — a @Public() method inside a protected
    // controller must win.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedProblem('Missing bearer token');
    }

    try {
      const claims = await this.tokens.verifyAccess(header.slice('Bearer '.length));
      (request as FastifyRequest & { user?: unknown }).user = claims;
      return true;
    } catch {
      // Expired and malformed are the same answer to the client. The
      // distinction is only useful to someone probing the signing key.
      throw new UnauthorizedProblem('Access token is invalid or expired');
    }
  }
}
