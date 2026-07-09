/**
 * HTTP metrics middleware — feeds the Prometheus registry in utils/metrics.ts.
 *
 * Route label cardinality: we deliberately use the *templated* route
 * (e.g. "/api/users/:id"), not the raw URL, to avoid an unbounded number of
 * time series (one real user id per series would make the metric useless
 * and eventually expensive). req.route is only populated by Express AFTER
 * the request has been matched to a handler, which is exactly why this
 * reads it inside the res.on('finish') callback rather than up front.
 *
 * Requests that never match any route (real 404s, or bots probing random
 * paths) are bucketed under the single label "unmatched" instead of the
 * raw path, for the same cardinality reason.
 */

import * as metrics from '../utils/metrics';

function metricsMiddleware(req: any, res: any, next: any) {
  const startNs = process.hrtime.bigint();
  metrics.httpActiveRequests.inc();

  res.on('finish', () => {
    metrics.httpActiveRequests.dec();

    const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    const matchedRoute = req.route ? `${req.baseUrl}${req.route.path}` : null;
    const route = matchedRoute || 'unmatched';
    const labels = { method: req.method, route, status_code: res.statusCode };

    metrics.httpRequestDuration.observe(labels, durationSeconds);
    metrics.httpRequestsTotal.inc(labels);
    if (res.statusCode >= 500) {
      metrics.httpErrorsTotal.inc(labels);
    }
  });

  next();
}

export { metricsMiddleware };
