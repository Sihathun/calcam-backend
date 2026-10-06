import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { publicRoute, reply, type RouteDef } from '../../lib/http/route';
import type { Metrics } from '../../lib/metrics';

const TAG = 'Ops';

export function opsRoutes(deps: AppDeps, getOpenApi: () => unknown, metrics?: Metrics): RouteDef[] {
  const routes: RouteDef[] = [
    publicRoute({
      method: 'get',
      path: '/health',
      root: true,
      tags: [TAG],
      summary: 'Liveness',
      description: 'Always 200 while the process is up. Does not touch dependencies.',
      responses: { 200: { description: 'Alive', schema: z.object({ status: z.literal('ok') }) } },
      handler: async () => ({ status: 'ok' }),
    }),

    publicRoute({
      method: 'get',
      path: '/ready',
      root: true,
      tags: [TAG],
      summary: 'Readiness',
      description: 'Checks the database, Redis (when used) and object storage. Answers 503 if any check fails.',
      responses: {
        200: { description: 'Ready', schema: readySchema },
        503: { description: 'A dependency is down', schema: readySchema },
      },
      handler: async () => {
        const checks: Record<string, 'ok' | 'fail'> = {};
        await Promise.all(
          deps.probes.map(async (p) => {
            try {
              await Promise.race([
                p.check(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
              ]);
              checks[p.name] = 'ok';
            } catch (err) {
              deps.logger.warn({ probe: p.name, err: (err as Error).message }, 'readiness check failed');
              checks[p.name] = 'fail';
            }
          }),
        );
        const ok = Object.values(checks).every((v) => v === 'ok');
        return reply(ok ? 200 : 503, { status: ok ? 'ready' : 'unavailable', checks });
      },
    }),

    publicRoute({
      method: 'get',
      path: '/openapi.json',
      root: true,
      tags: [TAG],
      summary: 'OpenAPI 3.1 document',
      description: 'Generated from the same route definitions that validate requests, so it matches the implementation. Swagger UI is at /docs.',
      responses: { 200: { description: 'OpenAPI document' } },
      handler: async () => getOpenApi(),
    }),
  ];

  if (metrics) {
    routes.push(
      publicRoute({
        method: 'get',
        path: '/metrics',
        root: true,
        tags: [TAG],
        summary: 'Prometheus metrics',
        description: 'Only mounted when METRICS_ENABLED=true. Keep it off the public internet.',
        responses: { 200: { description: 'Prometheus text format' } },
        handler: async ({ res }) => {
          res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
          return undefined;
        },
      }),
    );
  }
  return routes;
}

const readySchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
