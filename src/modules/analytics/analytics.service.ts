import { DateTime } from 'luxon';
import type { AppDeps } from '../../deps';
import { conflict } from '../../lib/errors';
import type { AuthUser } from '../../lib/http/route';
import { mealTotals, round1, sumNutrition } from '../../lib/nutrition';
import { addDays, dateKey, dayRange } from '../../lib/time';

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round(DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days);
}
import { goalAt, type GoalsService } from '../goals/goals.service';

export const RANGES = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type RangeKey = keyof typeof RANGES;
/** The longest window a custom `from`/`to` request may cover (a calendar year view). */
export const MAX_CUSTOM_DAYS = 366;

/** Either a named range ending today, or an explicit inclusive window of YYYY-MM-DD dates. */
export type SummaryWindow = { range: RangeKey } | { from: string; to: string };

export function createAnalyticsService(deps: AppDeps, goals: GoalsService) {
  const { prisma, clock } = deps;

  return {
    /** Per-day calories vs goal, macro averages, logging streak, weight trend and average health score. */
    async summary(user: AuthUser, zone: string, window: SummaryWindow) {
      const range = 'range' in window ? window.range : 'custom';
      const to = 'range' in window ? dateKey(clock(), zone) : window.to;
      const from = 'range' in window ? addDays(to, -(RANGES[window.range] - 1)) : window.from;
      const count = daysBetween(from, to) + 1;
      const start = dayRange(from, zone).start;
      const end = dayRange(to, zone).end;

      const history = await goals.history(user.id);
      if (!history.length) throw conflict('ONBOARDING_REQUIRED', 'Complete onboarding first');

      const [meals, weights] = await Promise.all([
        prisma.meal.findMany({
          where: { userId: user.id, deletedAt: null, loggedAt: { gte: start, lt: end }, analyzedAt: { not: null } },
          orderBy: { loggedAt: 'asc' },
        }),
        prisma.weightLog.findMany({
          where: { userId: user.id, loggedAt: { gte: start, lt: end } },
          orderBy: { loggedAt: 'asc' },
        }),
      ]);

      const byDay = new Map<string, typeof meals>();
      for (const m of meals) {
        const k = dateKey(m.loggedAt, zone);
        byDay.set(k, [...(byDay.get(k) ?? []), m]);
      }

      const days = Array.from({ length: count }, (_, i) => {
        const date = addDays(from, i);
        const dayMeals = byDay.get(date) ?? [];
        const totals = sumNutrition(dayMeals.map((m) => mealTotals(m)));
        const goal = goalAt(history, new Date(dayRange(date, zone).end.getTime() - 1))!;
        return {
          date,
          mealCount: dayMeals.length,
          calories: totals.calories,
          proteinG: totals.proteinG,
          carbsG: totals.carbsG,
          fatG: totals.fatG,
          goalCalories: goal.calories,
        };
      });

      const logged = days.filter((d) => d.mealCount > 0);
      const avg = (pick: (d: (typeof days)[number]) => number) =>
        logged.length ? round1(logged.reduce((s, d) => s + pick(d), 0) / logged.length) : 0;

      // Streaks count consecutive logged days. The current one may end yesterday (today is not over yet).
      let longest = 0;
      let run = 0;
      for (const d of days) {
        run = d.mealCount > 0 ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
      let current = 0;
      let i = days.length - 1;
      if (days[i]!.mealCount === 0) i -= 1;
      for (; i >= 0 && days[i]!.mealCount > 0; i--) current += 1;

      const scored = meals.filter((m) => m.healthScore !== null);
      const points = weights.map((w) => ({
        date: DateTime.fromJSDate(w.loggedAt, { zone }).toFormat('yyyy-LL-dd'),
        loggedAt: w.loggedAt.toISOString(),
        weightKg: w.weightKg,
      }));

      return {
        range,
        from,
        to,
        timezone: zone,
        days,
        averages: {
          calories: avg((d) => d.calories),
          proteinG: avg((d) => d.proteinG),
          carbsG: avg((d) => d.carbsG),
          fatG: avg((d) => d.fatG),
        },
        loggedDays: logged.length,
        streak: { current, longest },
        weight: {
          points,
          startKg: points[0]?.weightKg ?? null,
          latestKg: points.length ? points[points.length - 1]!.weightKg : null,
          changeKg: points.length > 1 ? round1(points[points.length - 1]!.weightKg - points[0]!.weightKg) : null,
        },
        averageHealthScore: scored.length ? round1(scored.reduce((s, m) => s + (m.healthScore ?? 0), 0) / scored.length) : null,
      };
    },
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
