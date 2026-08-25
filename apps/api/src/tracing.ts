/**
 * OpenTelemetry bootstrap.
 *
 * This file MUST be the first import in main.ts and worker.ts. The auto
 * instrumentations patch `http`, `pg` and `ioredis` at require time — anything
 * loaded before this runs is silently un-instrumented, and the symptom is a
 * trace with no database spans rather than an error.
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  // Service name is read from OTEL_SERVICE_NAME by the SDK itself. Building a
  // Resource by hand is the part of this API that churns between versions, so
  // we deliberately do not.
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        // Probes would otherwise be the overwhelming majority of all spans.
        ignoreIncomingRequestHook: (request) =>
          (request.url ?? '').startsWith('/health') ||
          (request.url ?? '').startsWith('/metrics'),
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();

  const shutdown = (): void => {
    void sdk.shutdown().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} else {
  // Explicit, because a silently-missing trace pipeline is worse than a noisy one.
  // eslint-disable-next-line no-console
  console.log('[tracing] OTEL_EXPORTER_OTLP_ENDPOINT unset — tracing disabled');
}
