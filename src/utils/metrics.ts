/**
 * Prometheus metrics registry (prom-client).
 *
 * Everything here is additive instrumentation — no existing request/socket
 * handling logic is changed, these metrics are only ever *read* from or
 * incremented alongside it. See src/index.ts for the /metrics endpoint and
 * the HTTP middleware that feeds httpRequestDuration/httpRequestsTotal/
 * httpErrorsTotal, and src/socket/presence.ts + src/socket/validation.ts
 * for where the socket-related metrics get updated.
 *
 * What each metric measures and why:
 *
 *   http_request_duration_seconds  Histogram — latency of every HTTP
 *                                   request, labeled by method/route/status.
 *   http_requests_total            Counter   — every HTTP response, same
 *                                   labels. Combine with the histogram's
 *                                   _count to sanity-check they agree.
 *   http_errors_total              Counter   — HTTP responses with a 5xx
 *                                   status only. Subset of http_requests_total.
 *   app_errors_total               Counter   — cross-cutting error counter
 *                                   labeled by `source` (http/socket/
 *                                   uncaught_exception/unhandled_rejection)
 *                                   — one counter to alert on for "is
 *                                   anything, anywhere, throwing more than
 *                                   usual".
 *   socket_errors_total            Counter   — Socket.io event handler
 *                                   errors, labeled by event name, so you
 *                                   can tell *which* feature is failing.
 *   cache_hits_total                Counter   — Redis cache hits, labeled by
 *                                   key prefix. See utils/cache.ts.
 *   cache_misses_total              Counter   — Redis cache misses (including
 *                                   read failures — a down Redis looks like
 *                                   100% misses here, which is the point).
 *   http_active_requests            Gauge     — HTTP requests currently
 *                                   in flight on this instance.
 *   socket_active_connections       Gauge     — Socket.io clients currently
 *                                   connected to this instance.
 *
 * Node.js process metrics (event loop lag, heap/RSS memory, GC pause
 * durations, open file descriptors, etc.) are collected automatically via
 * collectDefaultMetrics() below — these are prom-client's standard
 * `process_*`/`nodejs_*` metric names.
 */

import client from 'prom-client';

const register = new client.Registry();

// Standard process/runtime metrics (CPU, memory, event loop lag, GC,
// active handles, etc.) — cheap to collect, and event loop lag in
// particular is one of the single best "is this instance actually
// healthy" signals for a Node.js server under load.
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds, labeled by method, route, and status code',
  labelNames: ['method', 'route', 'status_code'],
  // Tuned for a realtime API: most requests should land well under 300ms;
  // buckets stretch out to 5s to still capture slow outliers (e.g. a slow
  // Supabase query) without every bucket being useless noise.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests handled, labeled by method, route, and status code',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpErrorsTotal = new client.Counter({
  name: 'http_errors_total',
  help: 'Total number of HTTP responses with a 5xx status code, labeled by method, route, and status code',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const appErrorsTotal = new client.Counter({
  name: 'app_errors_total',
  help: 'Total number of errors captured anywhere in the application, labeled by source',
  labelNames: ['source'], // 'http' | 'socket' | 'uncaught_exception' | 'unhandled_rejection'
  registers: [register],
});

const socketErrorsTotal = new client.Counter({
  name: 'socket_errors_total',
  help: 'Total number of Socket.io event handler errors, labeled by event name',
  labelNames: ['event'],
  registers: [register],
});

const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of Redis cache hits, labeled by key prefix (the part before the first ":")',
  labelNames: ['key_prefix'],
  registers: [register],
});

const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of Redis cache misses (including cache read failures), labeled by key prefix',
  labelNames: ['key_prefix'],
  registers: [register],
});

const httpActiveRequests = new client.Gauge({
  name: 'http_active_requests',
  help: 'Number of HTTP requests currently being processed by this server instance',
  registers: [register],
});

const socketActiveConnections = new client.Gauge({
  name: 'socket_active_connections',
  help: 'Number of Socket.io clients currently connected to this server instance',
  registers: [register],
});

export {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  httpErrorsTotal,
  appErrorsTotal,
  socketErrorsTotal,
  cacheHitsTotal,
  cacheMissesTotal,
  httpActiveRequests,
  socketActiveConnections,
};
