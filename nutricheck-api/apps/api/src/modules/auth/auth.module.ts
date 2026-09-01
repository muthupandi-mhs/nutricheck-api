import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleIdentityService } from './google-identity.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  // Secrets are passed per-call in TokenService rather than registered here:
  // access and refresh use different keys, and a module-level default is the
  // kind of thing that quietly signs a refresh token with the access secret.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    GoogleIdentityService,
    PasswordService,
    TokenService,
    // Global and fail-closed. A new controller is authenticated unless someone
    // deliberately writes @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
