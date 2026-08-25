import './tracing'; // must precede every other import — see tracing.ts

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './config/config.schema';

/**
 * The queue consumer. Same image as the API, different command.
 *
 * Created as a standalone application context: no HTTP listener, no port, no
 * ingress. Scaling is driven by queue depth rather than request concurrency, so
 * a corpus ingest cannot evict API capacity.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  app.flushLogs();
  app.enableShutdownHooks();

  const config = app.get(ConfigService<AppConfig, true>);
  app
    .get(Logger)
    .log(`worker started (${config.get('NODE_ENV', { infer: true })}) — no processors registered yet`);
}

void bootstrap();
