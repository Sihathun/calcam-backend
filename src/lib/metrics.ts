import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  middleware: RequestHandler;
}

/** Prometheus metrics for the API process. Served at /metrics when METRICS_ENABLED=true. */
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const histogram = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const middleware: RequestHandler = (req, res, next) => {
    const end = histogram.startTimer();
    res.on('finish', () => {
      // Use the route pattern, never the raw URL, so ids do not explode label cardinality.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  };

  return { registry, middleware };
}
