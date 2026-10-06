import { KCAL_PER_GRAM, type GoalLimits, type PlanConfig } from '../../config/plan';
import type { ActivityLevel, Diet, GoalType, Sex, WorkoutsPerWeek } from '../enums';
import { unprocessable } from '../errors';

/**
 * PlanService: pure functions, no I/O, deterministic for a given (input, config, now).
 * Every number the onboarding screens show (calories, macros, activity level, projection) comes from here.
 */

export interface PlanInput {
  sex: Sex;
  /** YYYY-MM-DD */
  birthDate: string;
  heightCm: number;
  weightKg: number;
  workoutsPerWeek: WorkoutsPerWeek;
  goal: GoalType;
  diet: Diet;
  targetWeightKg?: number | null;
}

export interface Macros {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface ProjectionPoint {
  day: number;
  progress: number;
  /** Null when the goal has no target weight (lose/gain without a target). */
  projectedWeightKg: number | null;
}

export interface PlanResult extends Macros {
  bmr: number;
  tdee: number;
  bmi: number;
  ageYears: number;
  activityLevel: ActivityLevel;
  goal: GoalType;
  weightKg: number;
  /** For "maintain" this is the current weight, which is what the pledge screen shows. */
  targetWeightKg: number | null;
  healthScoreEnabled: true;
  projection: ProjectionPoint[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function calculateAge(birthDate: string, now: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

export function calculateBmi(weightKg: number, heightCm: number): number {
  const m = heightCm / 100;
  return weightKg / (m * m);
}

export function calculateBmr(sex: Sex, weightKg: number, heightCm: number, age: number, cfg: PlanConfig): number {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + cfg.bmrOffset[sex];
}

export function activityFor(workouts: WorkoutsPerWeek, cfg: PlanConfig): ActivityLevel {
  return cfg.workoutsToActivity[workouts];
}

export function effectiveTargetWeight(input: PlanInput): number | null {
  return input.goal === 'maintain' ? input.weightKg : (input.targetWeightKg ?? null);
}

/** Splits a calorie target into whole grams. The result converts back to the target within a few kcal. */
export function splitMacros(calories: number, diet: Diet, cfg: PlanConfig): Macros {
  const split = cfg.macroSplit[diet];
  const proteinG = Math.round((calories * split.protein) / KCAL_PER_GRAM.protein);
  const fatG = Math.round((calories * split.fat) / KCAL_PER_GRAM.fat);
  // Carbs absorb the rounding so the macros add back up to the calorie target.
  const carbsG = Math.max(
    0,
    Math.round((calories - proteinG * KCAL_PER_GRAM.protein - fatG * KCAL_PER_GRAM.fat) / KCAL_PER_GRAM.carbs),
  );
  return { calories, proteinG, carbsG, fatG };
}

export function projectionFor(input: PlanInput, cfg: PlanConfig): ProjectionPoint[] {
  const target = effectiveTargetWeight(input);
  return cfg.projection.map((p) => ({
    day: p.day,
    progress: p.progress,
    projectedWeightKg: target === null ? null : round1(input.weightKg + (target - input.weightKg) * p.progress),
  }));
}

export function calculatePlan(input: PlanInput, cfg: PlanConfig, now: Date = new Date()): PlanResult {
  const age = calculateAge(input.birthDate, now);
  if (age < cfg.minAge) {
    throw unprocessable('UNDER_MINIMUM_AGE', `You must be at least ${cfg.minAge} years old to use this app.`);
  }
  if (age > cfg.maxAge) {
    throw unprocessable('INVALID_BIRTH_DATE', 'Please check your birth date.');
  }

  const bmi = calculateBmi(input.weightKg, input.heightCm);

  if (input.goal === 'lose') {
    if (bmi < cfg.minBmiForLose) {
      throw unprocessable(
        'GOAL_NOT_SUPPORTED',
        'Based on your height and weight, losing weight is not recommended. Maintaining or gaining weight may be a better fit.',
      );
    }
    if (input.targetWeightKg != null) {
      if (input.targetWeightKg >= input.weightKg) {
        throw unprocessable('INVALID_TARGET_WEIGHT', 'Your target weight must be below your current weight.');
      }
      if (calculateBmi(input.targetWeightKg, input.heightCm) < cfg.minBmiForLose) {
        throw unprocessable(
          'GOAL_NOT_SUPPORTED',
          'That target weight is below a healthy range for your height. Please choose a higher target.',
        );
      }
    }
  }
  if (input.goal === 'gain' && input.targetWeightKg != null && input.targetWeightKg <= input.weightKg) {
    throw unprocessable('INVALID_TARGET_WEIGHT', 'Your target weight must be above your current weight.');
  }

  const bmr = calculateBmr(input.sex, input.weightKg, input.heightCm, age, cfg);
  const activityLevel = activityFor(input.workoutsPerWeek, cfg);
  const tdee = bmr * cfg.activityMultiplier[activityLevel];

  let calories = Math.round(tdee * (1 + cfg.goalAdjustment[input.goal]));
  if (input.goal === 'lose') calories = Math.max(calories, cfg.loseCalorieFloor[input.sex]);
  calories = Math.min(Math.max(calories, cfg.limits.calories.min), cfg.limits.calories.max);

  return {
    ...splitMacros(calories, input.diet, cfg),
    bmr: round1(bmr),
    tdee: round1(tdee),
    bmi: round1(bmi),
    ageYears: age,
    activityLevel,
    goal: input.goal,
    weightKg: input.weightKg,
    targetWeightKg: effectiveTargetWeight(input),
    healthScoreEnabled: true,
    projection: projectionFor(input, cfg),
  };
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/** Clamps user-edited values: calories to 800-6000 and macros to non-negative whole grams. */
export function clampGoal(values: Partial<Macros>, base: Macros, limits: GoalLimits): Macros {
  const pick = (v: number | undefined, fallback: number, l: { min: number; max: number }) =>
    clamp(Math.round(v ?? fallback), l.min, l.max);
  return {
    calories: pick(values.calories, base.calories, limits.calories),
    proteinG: pick(values.proteinG, base.proteinG, limits.proteinG),
    carbsG: pick(values.carbsG, base.carbsG, limits.carbsG),
    fatG: pick(values.fatG, base.fatG, limits.fatG),
  };
}
