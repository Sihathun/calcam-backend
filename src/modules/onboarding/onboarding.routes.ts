import { authRoute, publicRoute, type RouteDef } from '../../lib/http/route';
import { meSchema } from '../../lib/dto';
import type { OnboardingService } from './onboarding.service';
import {
  onboardingPayloadSchema,
  optionsSchema,
  planInputSchema,
  planPreviewSchema,
} from './onboarding.schemas';

const TAG = 'Onboarding';

export function onboardingRoutes(svc: OnboardingService): RouteDef[] {
  return [
    publicRoute({
      method: 'get',
      path: '/onboarding/options',
      tags: [TAG],
      summary: 'Selectable values for every onboarding screen',
      description:
        'Codes with English display labels for sex, workouts per week, referral sources, diets, goals and accomplishments, plus supported locales and the edit limits for the plan screen. The client localises labels by code.',
      responses: { 200: { description: 'Options', schema: optionsSchema } },
      handler: async () => svc.options(),
    }),

    publicRoute({
      method: 'post',
      path: '/onboarding/plan-preview',
      tags: [TAG],
      summary: 'Calculate a nutrition plan without saving anything',
      description:
        'Stateless. Powers the "great potential" chart, the "setting everything up" screen and the daily recommendation screen. Returns 422 GOAL_NOT_SUPPORTED when a "lose" goal is not advisable (BMI below 18.5), and 422 UNDER_MINIMUM_AGE below 13.',
      limiter: 'planPreview',
      body: planInputSchema,
      responses: {
        200: { description: 'Calculated plan', schema: planPreviewSchema },
        422: { description: 'GOAL_NOT_SUPPORTED, UNDER_MINIMUM_AGE, INVALID_TARGET_WEIGHT or INVALID_BIRTH_DATE' },
      },
      handler: async ({ body }) => svc.preview(body),
    }),

    authRoute({
      method: 'post',
      path: '/onboarding/complete',
      tags: [TAG],
      summary: 'Save the onboarding answers for the signed-in user',
      description:
        'Same effect as the onboarding payload inside /auth/register, for users who signed up first. Idempotent: if the profile already exists, the stored state is returned unchanged.',
      body: onboardingPayloadSchema,
      responses: {
        200: { description: 'The user with profile and active goal', schema: meSchema },
        422: { description: 'GOAL_NOT_SUPPORTED, UNDER_MINIMUM_AGE, INVALID_TARGET_WEIGHT or INVALID_BIRTH_DATE' },
      },
      handler: async ({ user, body }) => svc.complete(user.id, body),
    }),
  ];
}
