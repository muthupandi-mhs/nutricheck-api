import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Opt a route out of JwtAuthGuard.
 *
 * The guard is global so the default is closed: a new controller is
 * authenticated unless someone deliberately writes @Public(). The opposite
 * default leaks an endpoint every time a decorator is forgotten.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
