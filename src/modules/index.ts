import type { AppDeps, WorkerDeps } from '../deps';
import type { RouteDef } from '../lib/http/route';
import type { JobProcessors } from '../lib/queue';
import type { Metrics } from '../lib/metrics';
import { analyticsRoutes } from './analytics/analytics.routes';
import { createAnalyticsService } from './analytics/analytics.service';
import { authRoutes } from './auth/auth.routes';
import { createAuthService } from './auth/auth.service';
import { createDashboardService } from './dashboard/dashboard.service';
import { dashboardRoutes } from './dashboard/dashboard.routes';
import { devicesRoutes } from './devices/devices.routes';
import { foodsRoutes } from './foods/foods.routes';
import { createFoodsService } from './foods/foods.service';
import { goalsRoutes } from './goals/goals.routes';
import { createGoalsService } from './goals/goals.service';
import { createAnalysisProcessor } from './meals/analysis.processor';
import { mealsRoutes } from './meals/meals.routes';
import { createMealsService } from './meals/meals.service';
import { onboardingRoutes } from './onboarding/onboarding.routes';
import { createOnboardingService } from './onboarding/onboarding.service';
import { opsRoutes } from './ops/ops.routes';
import { createAccountProcessor } from './profile/account.processor';
import { profileRoutes } from './profile/profile.routes';
import { createProfileService } from './profile/profile.service';
import { weightRoutes } from './weight/weight.routes';
import { createWeightService } from './weight/weight.service';

/** The single registry of HTTP routes. app.ts mounts it and openapi.ts documents it. */
export function buildRoutes(deps: AppDeps, getOpenApi: () => unknown, metrics?: Metrics): RouteDef[] {
  const onboarding = createOnboardingService(deps);
  const auth = createAuthService(deps, onboarding);
  const goals = createGoalsService(deps);
  const profile = createProfileService(deps, goals);
  const weight = createWeightService(deps, goals);
  const foods = createFoodsService(deps);
  const meals = createMealsService(deps);
  const dashboard = createDashboardService(deps, goals, meals.mapper);
  const analytics = createAnalyticsService(deps, goals);

  return [
    ...opsRoutes(deps, getOpenApi, metrics),
    ...authRoutes(auth),
    ...onboardingRoutes(onboarding),
    ...profileRoutes(profile),
    ...goalsRoutes(goals),
    ...weightRoutes(weight),
    ...devicesRoutes(deps),
    ...foodsRoutes(foods),
    ...mealsRoutes(meals),
    ...dashboardRoutes(dashboard),
    ...analyticsRoutes(analytics),
  ];
}

/** Everything the worker process runs. Shared by the BullMQ worker and the in-process memory queue. */
export function buildProcessors(deps: WorkerDeps): JobProcessors {
  return {
    analyzeMeal: createAnalysisProcessor(deps),
    deleteAccount: createAccountProcessor(deps),
  };
}
