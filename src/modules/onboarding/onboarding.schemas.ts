import { z } from 'zod';
import { dateOnly, goalLimitsSchema, isoInput, meSchema, planPreviewSchema } from '../../lib/dto';
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
import { isValidTimeZone } from '../../lib/time';

/** The inputs of the plan formula. Used by the unauthenticated preview and embedded in the full payload. */
export const planInputSchema = z.object({
  sex: sexSchema,
  birthDate: dateOnly,
  heightCm: z.number().min(50).max(272),
  weightKg: z.number().min(20).max(500),
  workoutsPerWeek: workoutsSchema,
  goal: goalSchema,
  diet: dietSchema,
  targetWeightKg: z.number().min(20).max(500).nullish(),
});

export type PlanInputPayload = z.infer<typeof planInputSchema>;

/** Values edited with the pencil icons on the plan screen. Out-of-range numbers are clamped, not rejected. */
export const acceptedGoalSchema = z.object({
  calories: z.number().finite().optional(),
  proteinG: z.number().finite().optional(),
  carbsG: z.number().finite().optional(),
  fatG: z.number().finite().optional(),
});

/**
 * Everything collected by the onboarding funnel. The survey fields are optional so older clients keep working.
 * referralSource, triedOtherApps, worksWithProfessional and accomplishment never enter the plan formula.
 */
export const onboardingPayloadSchema = planInputSchema.extend({
  referralSource: referralSourceSchema.nullish(),
  triedOtherApps: z.boolean().nullish(),
  worksWithProfessional: z.boolean().nullish(),
  accomplishment: accomplishmentSchema.nullish(),
  heightUnitPref: heightUnitSchema.default('cm'),
  weightUnitPref: weightUnitSchema.default('kg'),
  locale: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'Expected a language tag such as "en" or "pt-BR"')
    .optional(),
  timezone: z.string().refine(isValidTimeZone, 'Not a valid IANA timezone').optional(),
  commitment: z.object({ committedAt: isoInput }).optional(),
  acceptedGoal: acceptedGoalSchema.optional(),
});
export type OnboardingPayload = z.infer<typeof onboardingPayloadSchema>;

const option = z.object({ code: z.string(), label: z.string() });

export const optionsSchema = z.object({
  sex: z.array(option),
  workoutsPerWeek: z.array(option.extend({ description: z.string() })),
  referralSources: z.array(option),
  diets: z.array(option),
  goals: z.array(option),
  accomplishments: z.array(option),
  locales: z.array(option),
  goalLimits: goalLimitsSchema,
});

export const planPreviewBodySchema = planInputSchema;
export { planPreviewSchema, meSchema };
