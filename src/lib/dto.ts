import type { NutritionGoal, Profile, User } from '@prisma/client';
import { z } from 'zod';
import type { GoalLimits } from '../config/plan';
import {
  accomplishmentSchema,
  activityLevelSchema,
  dietSchema,
  goalSchema,
  goalSourceSchema,
  heightUnitSchema,
  referralSourceSchema,
  sexSchema,
  weightUnitSchema,
  workoutsSchema,
} from './enums';
import { isRealCalendarDate } from './time';
import type { PlanResult } from './plan-engine';

/** Shared request/response building blocks. */
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isRealCalendarDate, 'Not a real calendar date');

/** ISO-8601 timestamp. Offsets are accepted on input and normalised to UTC by the handlers. */
export const isoInput = z.iso.datetime({ offset: true });
export const isoOutput = z.iso.datetime();

export const uuidParam = z.object({ id: z.uuid() });

// ---------- goal ----------

export const goalDtoSchema = z.object({
  id: z.uuid(),
  calories: z.number().int(),
  proteinG: z.number().int(),
  carbsG: z.number().int(),
  fatG: z.number().int(),
  source: goalSourceSchema,
  bmr: z.number().nullable(),
  tdee: z.number().nullable(),
  effectiveFrom: isoOutput,
});
export type GoalDto = z.infer<typeof goalDtoSchema>;

export const toGoalDto = (g: NutritionGoal): GoalDto => ({
  id: g.id,
  calories: g.calories,
  proteinG: g.proteinG,
  carbsG: g.carbsG,
  fatG: g.fatG,
  source: g.source,
  bmr: g.bmr,
  tdee: g.tdee,
  effectiveFrom: g.effectiveFrom.toISOString(),
});

// ---------- plan ----------

export const planSchema = z.object({
  calories: z.number().int(),
  proteinG: z.number().int(),
  carbsG: z.number().int(),
  fatG: z.number().int(),
  bmr: z.number(),
  tdee: z.number(),
  bmi: z.number(),
  ageYears: z.number().int(),
  activityLevel: activityLevelSchema,
  healthScoreEnabled: z.literal(true),
});

export const planInfoSchema = z.object({
  weightKg: z.number(),
  activityLevel: activityLevelSchema,
  goal: goalSchema,
  /** For "maintain" this equals weightKg. Null for lose/gain without a target. */
  targetWeightKg: z.number().nullable(),
});

export const projectionSchema = z.array(
  z.object({
    day: z.number().int(),
    progress: z.number(),
    projectedWeightKg: z.number().nullable(),
  }),
);

export const goalLimitsSchema = z.object({
  calories: z.object({ min: z.number(), max: z.number() }),
  proteinG: z.object({ min: z.number(), max: z.number() }),
  carbsG: z.object({ min: z.number(), max: z.number() }),
  fatG: z.object({ min: z.number(), max: z.number() }),
});

export const planPreviewSchema = z.object({
  plan: planSchema,
  info: planInfoSchema,
  projection: projectionSchema,
  /** Bounds the client should enforce on the pencil-edit fields (values outside are clamped server-side). */
  limits: goalLimitsSchema,
});

export function toPlanPreview(p: PlanResult, limits: GoalLimits): z.infer<typeof planPreviewSchema> {
  return {
    plan: {
      calories: p.calories,
      proteinG: p.proteinG,
      carbsG: p.carbsG,
      fatG: p.fatG,
      bmr: p.bmr,
      tdee: p.tdee,
      bmi: p.bmi,
      ageYears: p.ageYears,
      activityLevel: p.activityLevel,
      healthScoreEnabled: true,
    },
    info: { weightKg: p.weightKg, activityLevel: p.activityLevel, goal: p.goal, targetWeightKg: p.targetWeightKg },
    projection: p.projection,
    limits,
  };
}

// ---------- me ----------

export const profileDtoSchema = z.object({
  sex: sexSchema,
  birthDate: dateOnly,
  heightCm: z.number(),
  heightUnitPref: heightUnitSchema,
  weightUnitPref: weightUnitSchema,
  workoutsPerWeek: workoutsSchema,
  activityLevel: activityLevelSchema,
  goal: goalSchema,
  /** For "maintain" this is the latest logged weight, matching the pledge screen ("maintaining 45 kg"). */
  targetWeightKg: z.number().nullable(),
  /** Latest logged weight. */
  weightKg: z.number().nullable(),
  diet: dietSchema,
  accomplishment: accomplishmentSchema.nullable(),
  referralSource: referralSourceSchema.nullable(),
  triedOtherApps: z.boolean().nullable(),
  worksWithProfessional: z.boolean().nullable(),
  commitmentAt: isoOutput.nullable(),
  onboardingCompletedAt: isoOutput,
});

export const meSchema = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  /** Name from the linked Google profile, null for email accounts. */
  displayName: z.string().nullable(),
  /** Google profile photo URL, null for email accounts. */
  avatarUrl: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  notificationsEnabled: z.boolean(),
  createdAt: isoOutput,
  onboardingCompleted: z.boolean(),
  profile: profileDtoSchema.nullable(),
  goal: goalDtoSchema.nullable(),
});
export type MeDto = z.infer<typeof meSchema>;

export function toProfileDto(p: Profile, latestWeightKg: number | null): z.infer<typeof profileDtoSchema> {
  return {
    sex: p.sex,
    birthDate: p.birthDate.toISOString().slice(0, 10),
    heightCm: p.heightCm,
    heightUnitPref: p.heightUnitPref,
    weightUnitPref: p.weightUnitPref,
    workoutsPerWeek: p.workoutsPerWeek,
    activityLevel: p.activityLevel,
    goal: p.goal,
    targetWeightKg: p.goal === 'maintain' ? latestWeightKg : p.targetWeightKg,
    weightKg: latestWeightKg,
    diet: p.diet,
    accomplishment: p.accomplishment,
    referralSource: p.referralSource,
    triedOtherApps: p.triedOtherApps,
    worksWithProfessional: p.worksWithProfessional,
    commitmentAt: p.commitmentAt?.toISOString() ?? null,
    onboardingCompletedAt: p.onboardingCompletedAt.toISOString(),
  };
}

export function toMeDto(
  user: User,
  profile: Profile | null,
  goal: NutritionGoal | null,
  latestWeightKg: number | null,
): MeDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    timezone: user.timezone,
    notificationsEnabled: user.notificationsEnabled,
    createdAt: user.createdAt.toISOString(),
    onboardingCompleted: profile !== null,
    profile: profile ? toProfileDto(profile, latestWeightKg) : null,
    goal: goal ? toGoalDto(goal) : null,
  };
}

// ---------- recalculation offer ----------

export const recalculationSchema = z.object({
  /** True when the stored goal no longer matches the profile and applying a recalculation would change it. */
  suggested: z.boolean(),
  /** Why a plan could not be offered, e.g. GOAL_NOT_SUPPORTED. */
  reason: z.string().nullable(),
  plan: planPreviewSchema.nullable(),
});
export type RecalculationDto = z.infer<typeof recalculationSchema>;
