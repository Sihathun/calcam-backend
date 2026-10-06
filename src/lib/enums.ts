import { z } from 'zod';

/**
 * Wire enums shared by request schemas, the plan engine and the options endpoint.
 * Values match the Prisma enums (workoutsPerWeek is converted in lib/mappers.ts).
 */
export const SEX = ['male', 'female', 'other'] as const;
export const WORKOUTS_PER_WEEK = ['0-2', '3-5', '6+'] as const;
export const GOALS = ['lose', 'maintain', 'gain'] as const;
export const DIETS = [
  'balanced',
  'whole_food',
  'mediterranean',
  'flexitarian',
  'pescatarian',
  'vegetarian',
  'vegan',
  'low_carb',
  'keto',
  'paleo',
] as const;
export const ACCOMPLISHMENTS = [
  'eat_healthier',
  'boost_energy_mood',
  'stay_motivated',
  'feel_better_body',
] as const;
export const REFERRAL_SOURCES = [
  'instagram',
  'facebook',
  'tiktok',
  'youtube',
  'google',
  'x',
  'friend_or_family',
  'play_store',
] as const;
export const HEIGHT_UNITS = ['ft_in', 'cm'] as const;
export const WEIGHT_UNITS = ['kg', 'lbs'] as const;
export const ACTIVITY_LEVELS = ['light', 'moderate', 'active'] as const;
export const GOAL_SOURCES = ['calculated', 'user_edited'] as const;
export const MEAL_SOURCES = ['photo', 'barcode', 'manual', 'text'] as const;
export const MEAL_STATUSES = ['queued', 'analyzing', 'completed', 'failed'] as const;
export const DEVICE_PLATFORMS = ['ios', 'android'] as const;
export const MEAL_ERROR_CODES = ['NOT_FOOD', 'LOW_CONFIDENCE', 'PROVIDER_ERROR'] as const;

export type Sex = (typeof SEX)[number];
export type WorkoutsPerWeek = (typeof WORKOUTS_PER_WEEK)[number];
export type GoalType = (typeof GOALS)[number];
export type Diet = (typeof DIETS)[number];
export type Accomplishment = (typeof ACCOMPLISHMENTS)[number];
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];
export type HeightUnit = (typeof HEIGHT_UNITS)[number];
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];
export type GoalSourceType = (typeof GOAL_SOURCES)[number];
export type MealSourceType = (typeof MEAL_SOURCES)[number];
export type MealStatusType = (typeof MEAL_STATUSES)[number];
export type DevicePlatformType = (typeof DEVICE_PLATFORMS)[number];
export type MealErrorCode = (typeof MEAL_ERROR_CODES)[number];

export const sexSchema = z.enum(SEX);
export const workoutsSchema = z.enum(WORKOUTS_PER_WEEK);
export const goalSchema = z.enum(GOALS);
export const dietSchema = z.enum(DIETS);
export const accomplishmentSchema = z.enum(ACCOMPLISHMENTS);
export const referralSourceSchema = z.enum(REFERRAL_SOURCES);
export const heightUnitSchema = z.enum(HEIGHT_UNITS);
export const weightUnitSchema = z.enum(WEIGHT_UNITS);
export const activityLevelSchema = z.enum(ACTIVITY_LEVELS);
export const goalSourceSchema = z.enum(GOAL_SOURCES);
export const mealSourceSchema = z.enum(MEAL_SOURCES);
export const mealStatusSchema = z.enum(MEAL_STATUSES);
export const devicePlatformSchema = z.enum(DEVICE_PLATFORMS);
