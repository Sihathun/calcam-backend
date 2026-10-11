import type { ActivityLevel, Diet, GoalType, Sex } from '../lib/enums';

export interface MacroSplit {
  protein: number;
  carbs: number;
  fat: number;
}

export interface ProjectionPointConfig {
  day: number;
  /** 0-1 fraction of the way to the goal. */
  progress: number;
}

export interface GoalLimits {
  calories: { min: number; max: number };
  proteinG: { min: number; max: number };
  carbsG: { min: number; max: number };
  fatG: { min: number; max: number };
}

export interface PlanConfig {
  minAge: number;
  maxAge: number;
  /** Mifflin-St Jeor sex offsets. See the note on defaultPlanConfig for "other". */
  bmrOffset: Record<Sex, number>;
  activityMultiplier: Record<ActivityLevel, number>;
  /** Fraction of TDEE added to (or removed from) the daily target. */
  goalAdjustment: Record<GoalType, number>;
  /** Lower bound for a "lose" plan, by sex. */
  loseCalorieFloor: Record<Sex, number>;
  /** A "lose" goal is refused below this BMI (also checked against the target weight). */
  minBmiForLose: number;
  limits: GoalLimits;
  macroSplit: Record<Diet, MacroSplit>;
  projection: ProjectionPointConfig[];
}

export const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

/**
 * Mifflin-St Jeor: 10*kg + 6.25*cm - 5*age + s, with s = +5 (male) and -161 (female).
 * The app also offers "other", for which no sex-specific offset is defined.
 * We use the midpoint, (5 + -161) / 2 = -78, which is the least biased choice.
 */
export const defaultPlanConfig: PlanConfig = {
  minAge: 13,
  maxAge: 120,
  bmrOffset: { male: 5, female: -161, other: -78 },
  // The five levels and multipliers of tdeecalculator.net.
  activityMultiplier: { sedentary: 1.2, light: 1.375, moderate: 1.55, heavy: 1.725, athlete: 1.9 },
  goalAdjustment: { lose: -0.15, maintain: 0, gain: 0.1 },
  loseCalorieFloor: { male: 1500, female: 1200, other: 1200 },
  minBmiForLose: 18.5,
  limits: {
    calories: { min: 800, max: 6000 },
    proteinG: { min: 0, max: 600 },
    carbsG: { min: 0, max: 1500 },
    fatG: { min: 0, max: 500 },
  },
  // Shares of calories. Each row sums to 1. The balanced row reproduces the
  // roughly 21/53/25 split of the design mock-up.
  macroSplit: {
    balanced: { protein: 0.22, carbs: 0.53, fat: 0.25 },
    whole_food: { protein: 0.25, carbs: 0.5, fat: 0.25 },
    mediterranean: { protein: 0.18, carbs: 0.47, fat: 0.35 },
    flexitarian: { protein: 0.2, carbs: 0.55, fat: 0.25 },
    pescatarian: { protein: 0.22, carbs: 0.5, fat: 0.28 },
    vegetarian: { protein: 0.18, carbs: 0.57, fat: 0.25 },
    vegan: { protein: 0.17, carbs: 0.58, fat: 0.25 },
    low_carb: { protein: 0.3, carbs: 0.3, fat: 0.4 },
    keto: { protein: 0.2, carbs: 0.05, fat: 0.75 },
    paleo: { protein: 0.3, carbs: 0.35, fat: 0.35 },
  },
  // Slow start, acceleration after day 7, goal reached at day 30 (screen "You have great potential").
  projection: [
    { day: 3, progress: 0.1 },
    { day: 7, progress: 0.35 },
    { day: 30, progress: 1.0 },
  ],
};
