import { z } from 'zod';
import { goalDtoSchema } from '../../lib/dto';
import { authRoute, type RouteDef } from '../../lib/http/route';
import type { GoalsService } from './goals.service';

const TAG = 'Goals';

const editBody = z
  .object({
    calories: z.number().finite().optional(),
    proteinG: z.number().finite().optional(),
    carbsG: z.number().finite().optional(),
    fatG: z.number().finite().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one of calories, proteinG, carbsG, fatG');

export function goalsRoutes(svc: GoalsService): RouteDef[] {
  return [
    authRoute({
      method: 'get',
      path: '/me/goals',
      tags: [TAG],
      summary: 'The active nutrition goal',
      responses: { 200: { description: 'Active goal', schema: goalDtoSchema }, 404: { description: 'NO_ACTIVE_GOAL' } },
      handler: async ({ user }) => svc.getActive(user.id),
    }),

    authRoute({
      method: 'put',
      path: '/me/goals',
      tags: [TAG],
      summary: 'Edit calories or macros (the pencil icons)',
      description:
        'Fields you omit keep their current value. Calories are clamped to 800-6000 and macros to their configured limits. Creates a new `user_edited` version; earlier days keep the goal that was active then.',
      body: editBody,
      responses: {
        200: { description: 'The new active goal', schema: goalDtoSchema },
        409: { description: 'ONBOARDING_REQUIRED' },
      },
      handler: async ({ user, body }) => svc.edit(user.id, body),
    }),

    authRoute({
      method: 'post',
      path: '/me/goals/recalculate',
      tags: [TAG],
      summary: 'Recalculate the plan from the current profile and latest weight',
      responses: {
        200: { description: 'The new active goal', schema: goalDtoSchema },
        409: { description: 'ONBOARDING_REQUIRED or WEIGHT_REQUIRED' },
        422: { description: 'GOAL_NOT_SUPPORTED' },
      },
      handler: async ({ user }) => svc.recalculate(user.id),
    }),
  ];
}
