import { z } from 'zod';
import { isoInput, isoOutput, recalculationSchema, uuidParam } from '../../lib/dto';
import { authRoute, reply, type RouteDef } from '../../lib/http/route';
import type { WeightService } from './weight.service';

const TAG = 'Weight';

const weightLogSchema = z.object({ id: z.uuid(), weightKg: z.number(), loggedAt: isoOutput });

export function weightRoutes(svc: WeightService): RouteDef[] {
  return [
    authRoute({
      method: 'post',
      path: '/me/weight-logs',
      tags: [TAG],
      summary: 'Log a weight',
      description:
        'Weight is metric on the wire (the client converts lbs). The response includes a recalculation offer when the new weight moves the plan.',
      body: z.object({ weightKg: z.number().min(20).max(500), loggedAt: isoInput.optional() }),
      responses: {
        201: {
          description: 'Logged',
          schema: z.object({ weightLog: weightLogSchema, recalculation: recalculationSchema }),
        },
      },
      handler: async ({ user, body }) => svc.add(user.id, body),
    }),

    authRoute({
      method: 'get',
      path: '/me/weight-logs',
      tags: [TAG],
      summary: 'Weight history for charts',
      description: 'Oldest first. `from` and `to` are inclusive ISO timestamps.',
      query: z.object({
        from: isoInput.optional(),
        to: isoInput.optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(365),
      }),
      responses: { 200: { description: 'Entries', schema: z.object({ items: z.array(weightLogSchema) }) } },
      handler: async ({ user, query }) => svc.list(user.id, query),
    }),

    authRoute({
      method: 'delete',
      path: '/me/weight-logs/:id',
      tags: [TAG],
      summary: 'Delete a weight entry',
      params: uuidParam,
      responses: { 204: { description: 'Deleted' }, 404: { description: 'WEIGHT_LOG_NOT_FOUND' } },
      handler: async ({ user, params }) => {
        await svc.remove(user.id, params.id);
        return reply(204);
      },
    }),
  ];
}
