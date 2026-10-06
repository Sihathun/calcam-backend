import { z } from 'zod';
import { dateOnly, isoOutput } from '../../lib/dto';
import { authRoute, type RouteDef } from '../../lib/http/route';
import { resolveZone } from '../../lib/time';
import { RANGES, type AnalyticsService } from './analytics.service';

const summarySchema = z.object({
  range: z.enum(Object.keys(RANGES) as [keyof typeof RANGES, ...(keyof typeof RANGES)[]]),
  from: dateOnly,
  to: dateOnly,
  timezone: z.string(),
  days: z.array(
    z.object({
      date: dateOnly,
      mealCount: z.number().int(),
      calories: z.number(),
      proteinG: z.number(),
      carbsG: z.number(),
      fatG: z.number(),
      goalCalories: z.number(),
    }),
  ),
  /** Averages over the days that have at least one counted meal. */
  averages: z.object({ calories: z.number(), proteinG: z.number(), carbsG: z.number(), fatG: z.number() }),
  loggedDays: z.number().int(),
  streak: z.object({ current: z.number().int(), longest: z.number().int() }),
  weight: z.object({
    points: z.array(z.object({ date: dateOnly, loggedAt: isoOutput, weightKg: z.number() })),
    startKg: z.number().nullable(),
    latestKg: z.number().nullable(),
    changeKg: z.number().nullable(),
  }),
  averageHealthScore: z.number().nullable(),
});

export function analyticsRoutes(svc: AnalyticsService): RouteDef[] {
  return [
    authRoute({
      method: 'get',
      path: '/analytics/summary',
      tags: ['Analytics'],
      summary: 'Calories vs goal, macro averages, streak and weight trend',
      description:
        'The window ends today in the user\'s timezone (or the `X-Timezone` header). Each day is compared with the goal that was active on that day. The streak is capped by the window.',
      query: z.object({ range: z.enum(['7d', '30d', '90d']).default('7d') }),
      responses: { 200: { description: 'Summary', schema: summarySchema }, 409: { description: 'ONBOARDING_REQUIRED' } },
      handler: async ({ req, user, query }) =>
        svc.summary(user, resolveZone(req.header('x-timezone'), user.timezone), query.range),
    }),
  ];
}
