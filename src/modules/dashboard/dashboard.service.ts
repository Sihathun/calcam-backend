import type { AppDeps } from '../../deps';
import { conflict } from '../../lib/errors';
import type { AuthUser } from '../../lib/http/route';
import { mealTotals, subtractNutrition, sumNutrition, type Nutrition } from '../../lib/nutrition';
import { dayRange, resolveDateParam } from '../../lib/time';
import { goalAt, type GoalsService } from '../goals/goals.service';
import type { MealMapper } from '../meals/meals.mapper';

export function createDashboardService(deps: AppDeps, goals: GoalsService, mapper: MealMapper) {
  const { prisma, clock } = deps;

  return {
    /**
     * Home screen (Today / Yesterday). Meals still being analyzed are listed but not counted.
     * The goal is the one that was active on that day, so later edits never rewrite history.
     */
    async daily(user: AuthUser, zone: string, dateParam: string | undefined) {
      const date = resolveDateParam(dateParam, zone, clock());
      const { start, end } = dayRange(date, zone);

      const history = await goals.history(user.id);
      const active = goalAt(history, new Date(end.getTime() - 1));
      if (!active) throw conflict('ONBOARDING_REQUIRED', 'Complete onboarding first');
      const goal: Nutrition = {
        calories: active.calories,
        proteinG: active.proteinG,
        carbsG: active.carbsG,
        fatG: active.fatG,
      };

      const meals = await prisma.meal.findMany({
        where: { userId: user.id, deletedAt: null, loggedAt: { gte: start, lt: end } },
        orderBy: [{ loggedAt: 'desc' }, { id: 'desc' }],
      });

      // mealTotals is null until a meal has values, which is what excludes "Analyzing food..." cards.
      const consumed = sumNutrition(meals.map((m) => mealTotals(m)));
      return {
        date,
        timezone: zone,
        goal,
        consumed,
        // May go negative. The client decides how to show an overshoot.
        remaining: subtractNutrition(goal, consumed),
        meals: await Promise.all(meals.map((m) => mapper.summary(m))),
      };
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
