import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import type { AppConfig } from './config.schema';
import { validateConfig } from './config.schema';

/** Typed accessor. `config.get('PORT')` is a number, not `string | undefined`. */
export type TypedConfigService = ConfigService<AppConfig, true>;

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // The container supplies env directly; .env files are a local convenience.
      envFilePath: ['.env.local', '.env'],
      validate: validateConfig,
      expandVariables: true,
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
