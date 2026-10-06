import { z } from 'zod';
import { dateOnly } from '../../lib/dto';
import { authRoute, type RouteDef } from '../../lib/http/route';
import { resolveZone } from '../../lib/time';
import { dateParamSchema, mealSummarySchema } from '../meals/meals.schemas';
import type { DashboardService } from './dashboard.service';

const macros = z.object({
  calories: z.number(),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
});

export const dailyDashboardSchema = z.object({
  date: dateOnly,
  timezone: z.string(),
  goal: macros,
  consumed: macros,
  remaining: macros,
  meals: z.array(mealSummarySchema),
});

export function dashboardRoutes(svc: DashboardService): RouteDef[] {
  return [
    authRoute({
      method: 'get',
      path: '/dashboard/daily',
      tags: ['Dashboard'],
      summary: 'Home screen: calories and macros left for a day',
      description:
        'Powers Today / Yesterday. `date` is YYYY-MM-DD, `today` or `yesterday` (default today), resolved in the user\'s timezone, or the `X-Timezone` header when sent. Meals still analyzing are listed but not counted. `remaining` may be negative. The goal returned is the one active on that day.',
      query: z.object({ date: dateParamSchema.optional() }),
      responses: { 200: { description: 'The day', schema: dailyDashboardSchema }, 409: { description: 'ONBOARDING_REQUIRED' } },
      handler: async ({ req, user, query }) =>
        svc.daily(user, resolveZone(req.header('x-timezone'), user.timezone), query.date),
    }),
  ];
}
