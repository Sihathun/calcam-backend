import { z } from 'zod';
import { dateOnly, meSchema, profileDtoSchema, recalculationSchema } from '../../lib/dto';
import {
  accomplishmentSchema,
  dietSchema,
  goalSchema,
  heightUnitSchema,
  referralSourceSchema,
  sexSchema,
  weightUnitSchema,
  workoutsSchema,
} from '../../lib/enums';
import { authRoute, reply, type RouteDef } from '../../lib/http/route';
import { isValidTimeZone } from '../../lib/time';
import { statusSchema } from '../auth/auth.schemas';
import type { ProfileService } from './profile.service';

const TAG = 'Profile';

const profilePatchSchema = z
  .object({
    sex: sexSchema,
    birthDate: dateOnly,
    heightCm: z.number().min(50).max(272),
    heightUnitPref: heightUnitSchema,
    weightUnitPref: weightUnitSchema,
    workoutsPerWeek: workoutsSchema,
    goal: goalSchema,
    targetWeightKg: z.number().min(20).max(500).nullable(),
    diet: dietSchema,
    accomplishment: accomplishmentSchema.nullable(),
    referralSource: referralSourceSchema.nullable(),
    triedOtherApps: z.boolean().nullable(),
    worksWithProfessional: z.boolean().nullable(),
    weightKg: z.number().min(20).max(500).describe('Logs a new weight entry'),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to change');

const preferencesSchema = z
  .object({
    locale: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
    timezone: z.string().refine(isValidTimeZone, 'Not a valid IANA timezone'),
    heightUnitPref: heightUnitSchema,
    weightUnitPref: weightUnitSchema,
    notificationsEnabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to change');

export function profileRoutes(svc: ProfileService): RouteDef[] {
  return [
    authRoute({
      method: 'get',
      path: '/me',
      tags: [TAG],
      summary: 'The signed-in user with profile and active goal',
      responses: { 200: { description: 'Current user', schema: meSchema } },
      handler: async ({ user }) => svc.getMe(user.id),
    }),

    authRoute({
      method: 'patch',
      path: '/me/profile',
      tags: [TAG],
      summary: 'Edit profile fields',
      description:
        'Changing sex, birthDate, height, weight, goal, activity (workoutsPerWeek) or diet returns a `recalculation` offer. Nothing is recalculated until the client calls POST /me/goals/recalculate. A `weightKg` value is logged as a new weight entry.',
      body: profilePatchSchema,
      responses: {
        200: {
          description: 'Updated profile and recalculation offer',
          schema: z.object({ profile: profileDtoSchema, recalculation: recalculationSchema }),
        },
        409: { description: 'ONBOARDING_REQUIRED' },
        422: { description: 'GOAL_NOT_SUPPORTED, UNDER_MINIMUM_AGE, INVALID_TARGET_WEIGHT' },
      },
      handler: async ({ user, body }) => svc.updateProfile(user.id, body),
    }),

    authRoute({
      method: 'patch',
      path: '/me/preferences',
      tags: [TAG],
      summary: 'Language, timezone, units and notifications',
      description: 'Units only affect display; everything stays metric on the wire.',
      body: preferencesSchema,
      responses: { 200: { description: 'Updated user', schema: meSchema }, 409: { description: 'ONBOARDING_REQUIRED (unit preferences need a profile)' } },
      handler: async ({ user, body }) => svc.updatePreferences(user.id, body),
    }),

    authRoute({
      method: 'delete',
      path: '/me',
      tags: [TAG],
      summary: 'Delete the account',
      description:
        'The account is disabled immediately and all tokens are revoked. A background job then hard-deletes every row and stored image.',
      responses: { 202: { description: 'Deletion scheduled', schema: statusSchema } },
      handler: async ({ user }) => {
        await svc.requestDeletion(user.id);
        return reply(202, { status: 'ok' });
      },
    }),
  ];
}
