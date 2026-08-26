import './tracing'; // must precede every other import — see tracing.ts

import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import type { AppConfig } from './config/config.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Behind an ingress, so client IPs come from X-Forwarded-For. Without
      // this the rate limiter sees one address for the entire internet.
      trustProxy: true,
      /**
       * Sized for the ONE route that carries a payload: `POST /v1/transcribe`.
       *
       * This is Fastify's limit on the RAW body, and it is checked long before
       * any controller runs — so it silently outranks `TRANSCRIBE_MAX_BYTES`.
       * At 256 KB it did: that route advertised a 2 MB ceiling and its own
       * friendly 413, neither of which could ever be reached, because base64
       * inflates audio by a third and the framework had already refused the
       * request.
       *
       * 2 MB of audio needs ~2.67 MB of base64 plus the JSON around it. Keep
       * these two in step — lowering this without lowering the route's limit
       * puts the lie back.
       */
      bodyLimit: 3 * 1024 * 1024,
      genReqId: () => crypto.randomUUID(),
    }),
    // Buffer until the pino logger is resolved, so boot-time errors are not
    // emitted through the default console logger in a different format.
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.flushLogs();

  const config = app.get(ConfigService<AppConfig, true>);
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new AllExceptionsFilter());

  // A native client sends no Origin, so CORS stays off in production. It is
  // enabled in development only so the OpenAPI page can be driven from a browser.
  if (!isProduction) {
    app.enableCors({ origin: true });
  }

  await app.register(helmet, {
    contentSecurityPolicy: isProduction,
  });

  // Documentation must never be able to stop the service. Swagger's schema
  // factory throws on a shape it cannot resolve, and an un-guarded call here
  // turns a docs-rendering problem into a boot crash — which is exactly what
  // happened when a nullable DTO field reached it without an explicit type.
  if (!isProduction) {
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('NutriCheck API')
          .setDescription('Nutrition tracker backend. Schemas generated from @nutricheck/contracts.')
          .setVersion('1')
          .addBearerAuth()
          .build(),
      );
      SwaggerModule.setup('docs', app, document);
    } catch (error) {
      app.get(Logger).error({ err: error }, 'OpenAPI generation failed — /docs disabled');
    }
  }

  // SIGTERM -> stop accepting, drain in-flight work, close pools, exit.
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  // 0.0.0.0 is not optional in a container: Node's default binds loopback and
  // the container answers nothing from outside.
  await app.listen({ port, host: '0.0.0.0' });

  app.get(Logger).log(`api listening on :${port} (${config.get('NODE_ENV', { infer: true })})`);
}

void bootstrap();
