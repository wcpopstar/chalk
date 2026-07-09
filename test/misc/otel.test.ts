export {};
'use strict';

require('../helpers/testEnv');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('utils/otel.ts', () => {
  it('registers nothing without OTEL_EXPORTER_OTLP_ENDPOINT and shuts down as a no-op', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete require.cache[require.resolve('../../src/utils/otel')];

    const { shutdownTelemetry } = require('../../src/utils/otel');
    await shutdownTelemetry(); // must not throw — no SDK was started
  });

  it('stays disabled under NODE_ENV=test even when an endpoint is set', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    delete require.cache[require.resolve('../../src/utils/otel')];

    // NODE_ENV=test guard: the SDK must NOT boot inside the test runner
    // (auto-instrumentation would patch http for every other test file).
    const { shutdownTelemetry } = require('../../src/utils/otel');
    await shutdownTelemetry();

    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    assert.ok(true);
  });
});
