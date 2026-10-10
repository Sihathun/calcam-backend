import { z } from 'zod';
import { dateOnly, isoOutput } from '../../lib/dto';
import { authRoute, type RouteDef } from '../../lib/http/route';
import { resolveZone } from '../../lib/time';
import { daysBetween, MAX_CUSTOM_DAYS, RANGES, type AnalyticsService } from './analytics.service';

const summaryQuerySchema = z
  .object({
    range: z.enum(['7d', '30d', '90d']).default('7d'),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.from === undefined) !== (q.to === undefined)) {
      ctx.addIssue({ code: 'custom', path: [q.from === undefined ? 'from' : 'to'], message: 'Send from and to together' });
      return;
    }
    if (q.from === undefined || q.to === undefined) return;
    const span = daysBetween(q.from, q.to);
    if (span < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must not be before from' });
    else if (span + 1 > MAX_CUSTOM_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `At most ${MAX_CUSTOM_DAYS} days` });
    }
  });

const summarySchema = z.object({
  /** `custom` when the request used `from` and `to`. */
  range: z.enum([...(Object.keys(RANGES) as (keyof typeof RANGES)[]), 'custom']),
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
        'The window ends today in the user\'s timezone (or the `X-Timezone` header), or is the inclusive `from`/`to` window (both YYYY-MM-DD, at most 366 days; they override `range`). Each day is compared with the goal that was active on that day. The streak is capped by the window and counts back from its last day.',
      query: summaryQuerySchema,
      responses: { 200: { description: 'Summary', schema: summarySchema }, 409: { description: 'ONBOARDING_REQUIRED' } },
      handler: async ({ req, user, query }) =>
        svc.summary(
          user,
          resolveZone(req.header('x-timezone'), user.timezone),
          query.from && query.to ? { from: query.from, to: query.to } : { range: query.range },
        ),
    }),
  ];
}
