// ── OpenTelemetry tracing ───────────────────────────────────────────────────
// Distributed tracing via the standard OTel Node SDK + auto-instrumentation
// (http, express, ioredis, pino trace-context injection, ...). Spans are
// shipped over OTLP/HTTP to whatever collector OTEL_EXPORTER_OTLP_ENDPOINT
// points at (Grafana Tempo, Jaeger, Honeycomb, an otel-collector sidecar —
// anything that speaks OTLP).
//
// MUST be imported before express/http/ioredis are first require()d —
// auto-instrumentation works by patching those modules at load time, so
// index.ts imports this file at the very top (right after dotenv).
//
// Enabled ONLY when OTEL_EXPORTER_OTLP_ENDPOINT is set: without it this
// module registers nothing and adds zero runtime overhead. That keeps
// dev/test completely unaffected — same opt-in pattern as Sentry (DSN)
// and PostHog (API key).
//
// NOTE: reads process.env directly instead of config/env — config's module
// graph pulls in the logger and (transitively) nothing else, but keeping
// this file dependency-free guarantees nothing instrumentable loads before
// the SDK patches it. This is the third sanctioned process.env reader
// (see config/env.ts's header) for exactly that load-order reason.

let sdk: any = null;

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null;

if (endpoint && process.env.NODE_ENV !== 'test') {
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

    sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || 'chalk-backend',
      traceExporter: new OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT itself
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs spans are overwhelmingly noise (every require, every static
          // file read) — the classic first thing everyone disables.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });
    sdk.start();
    // Deliberately console.log, not the pino logger: importing the logger
    // here would load pino before its instrumentation patches it.
    console.log(`OpenTelemetry tracing enabled -> ${endpoint}`);
  } catch (err) {
    console.error('OpenTelemetry init failed — continuing WITHOUT tracing', err);
    sdk = null;
  }
}

/** Flushes and stops the tracer; called from graceful shutdown. */
async function shutdownTelemetry() {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('OpenTelemetry shutdown failed', err);
  }
}

export { shutdownTelemetry };
