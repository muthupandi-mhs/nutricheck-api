import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { ProblemThrottlerGuard } from './common/guards/problem-throttler.guard';
import { ZodValidationPipe } from './common/zod/zod-validation.pipe';
import { ConfigModule } from './config/config.module';
import type { AppConfig } from './config/config.schema';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { FoodsModule } from './modules/foods/foods.module';
import { GoalsModule } from './modules/goals/goals.module';
import { LogsModule } from './modules/logs/logs.module';
import { QuotaModule } from './modules/quota/quota.module';
import { AiMealModule } from './modules/ai-meal/ai-meal.module';
import { ResolverModule } from './modules/resolver/resolver.module';
import { MealsModule } from './modules/meals/meals.module';
import { SuggestionsModule } from './modules/suggestions/suggestions.module';
import { IdeasModule } from './modules/ideas/ideas.module';
import { InsightsModule } from './modules/insights/insights.module';
import { TranscriptionModule } from './modules/transcription/transcription.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';
import { WeightModule } from './modules/weight/weight.module';

@Module({
  imports: [
    ConfigModule,

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const isDev = config.get('NODE_ENV', { infer: true }) !== 'production';
        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            genReqId: (req, res) => {
              const existing = req.headers['x-request-id'];
              const id = typeof existing === 'string' ? existing : randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            autoLogging: {
              // Probes are ~90% of request volume and 0% of what anyone reads.
              ignore: (req) => (req.url ?? '').startsWith('/health'),
            },
            // Redaction is configured, not remembered. The meal phrase is
            // health-adjacent personal data and is logged at debug only, from
            // the resolver, never through the generic request logger.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'req.body.password',
                'req.body.idToken',
                'req.body.refreshToken',
                'req.body.phrase',
                '*.apiKey',
                '*.api_key',
              ],
              censor: '[redacted]',
            },
            transport: isDev
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
              : undefined,
          },
        };
      },
    }),

    ThrottlerModule.forRoot({
      throttlers: [
        // A coarse default. Auth routes and the resolver get their own,
        // stricter limits at the controller level.
        { name: 'default', ttl: 60_000, limit: 120 },
      ],
    }),

    DatabaseModule,
    RedisModule,
    HealthModule,
    AuthModule,
    UsersModule,
    FoodsModule,
    GoalsModule,
    WeightModule,
    LogsModule,
    MealsModule,
    SuggestionsModule,
    TranscriptionModule,
    InsightsModule,
    IdeasModule,
    QuotaModule,
    AiMealModule,
    ResolverModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Deliberately NOT APP_GUARD: the throttler is applied per-controller so a
    // burst on search cannot consume the budget that protects auth.
    ProblemThrottlerGuard,
  ],
})
export class AppModule {}
