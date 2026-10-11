import { describe, expect, it } from 'vitest';
import { defaultPlanConfig, KCAL_PER_GRAM } from '../../config/plan';
import { DIETS, GOALS, SEX, WORKOUTS_PER_WEEK } from '../enums';
import { AppError } from '../errors';
import { calculateAge, calculateBmi, calculatePlan, clampGoal, type PlanInput } from './index';

const cfg = defaultPlanConfig;
const NOW = new Date('2026-10-06T12:00:00Z');

/**
 * Expected values were derived with plain arithmetic, independently of the engine:
 *   BMR  = 10*kg + 6.25*cm - 5*age + (male 5 | female -161 | other -78)
 *   TDEE = BMR * (1.2 | 1.375 | 1.55 | 1.725 | 1.9), the tdeecalculator.net multipliers
 *   kcal = round(TDEE * (0.85 | 1 | 1.10)), raised to the floor for "lose" (1500 male, 1200 otherwise)
 *   protein = round(kcal*p/4), fat = round(kcal*f/9), carbs = round((kcal - 4*protein - 9*fat)/4)
 */
const fixtures: {
  name: string;
  input: PlanInput;
  expect: { age: number; bmi: number; bmr: number; tdee: number; calories: number; proteinG: number; carbsG: number; fatG: number; activity: string };
}[] = [
  {
    name: 'young woman, light activity, maintain, balanced (the design mock-up profile)',
    input: { sex: 'female', birthDate: '2001-01-01', heightCm: 167.6, weightKg: 54, workoutsPerWeek: 'light', goal: 'maintain', diet: 'balanced' },
    expect: { age: 25, bmi: 19.2, bmr: 1301.5, tdee: 1789.6, calories: 1790, proteinG: 98, carbsG: 237, fatG: 50, activity: 'light' },
  },
  {
    name: 'man, moderate, gain, keto',
    input: { sex: 'male', birthDate: '1990-05-05', heightCm: 180, weightKg: 80, workoutsPerWeek: 'moderate', goal: 'gain', diet: 'keto' },
    expect: { age: 36, bmi: 24.7, bmr: 1750, tdee: 2712.5, calories: 2984, proteinG: 149, carbsG: 37, fatG: 249, activity: 'moderate' },
  },
  {
    name: '"other" uses the midpoint offset, lose, vegan, birthday later this year (age 40)',
    input: { sex: 'other', birthDate: '1985-12-31', heightCm: 170, weightKg: 70, workoutsPerWeek: 'heavy', goal: 'lose', diet: 'vegan' },
    expect: { age: 40, bmi: 24.2, bmr: 1484.5, tdee: 2560.8, calories: 2177, proteinG: 93, carbsG: 316, fatG: 60, activity: 'heavy' },
  },
  {
    name: 'man, light, lose, mediterranean',
    input: { sex: 'male', birthDate: '1970-01-15', heightCm: 175, weightKg: 95, workoutsPerWeek: 'light', goal: 'lose', diet: 'mediterranean' },
    expect: { age: 56, bmi: 31, bmr: 1768.8, tdee: 2432, calories: 2067, proteinG: 93, carbsG: 244, fatG: 80, activity: 'light' },
  },
  {
    name: 'woman: the 1200 kcal floor applies to a "lose" plan',
    input: { sex: 'female', birthDate: '1966-02-02', heightCm: 150, weightKg: 42, workoutsPerWeek: 'light', goal: 'lose', diet: 'balanced' },
    expect: { age: 60, bmi: 18.7, bmr: 896.5, tdee: 1232.7, calories: 1200, proteinG: 66, carbsG: 160, fatG: 33, activity: 'light' },
  },
  {
    name: 'man: the 1500 kcal floor applies to a "lose" plan',
    input: { sex: 'male', birthDate: '1956-06-06', heightCm: 160, weightKg: 48, workoutsPerWeek: 'light', goal: 'lose', diet: 'balanced' },
    expect: { age: 70, bmi: 18.7, bmr: 1135, tdee: 1560.6, calories: 1500, proteinG: 83, carbsG: 198, fatG: 42, activity: 'light' },
  },
  {
    name: 'woman, moderate, maintain, low-carb',
    input: { sex: 'female', birthDate: '1999-09-09', heightCm: 165, weightKg: 60, workoutsPerWeek: 'moderate', goal: 'maintain', diet: 'low_carb' },
    expect: { age: 27, bmi: 22, bmr: 1335.3, tdee: 2069.6, calories: 2070, proteinG: 155, carbsG: 156, fatG: 92, activity: 'moderate' },
  },
  {
    name: 'man, active, gain, paleo',
    input: { sex: 'male', birthDate: '1988-08-08', heightCm: 185, weightKg: 75, workoutsPerWeek: 'heavy', goal: 'gain', diet: 'paleo' },
    expect: { age: 38, bmi: 21.9, bmr: 1721.3, tdee: 2969.2, calories: 3266, proteinG: 245, carbsG: 286, fatG: 127, activity: 'heavy' },
  },
  {
    name: 'woman, moderate, maintain, pescatarian',
    input: { sex: 'female', birthDate: '1992-04-04', heightCm: 170, weightKg: 65, workoutsPerWeek: 'moderate', goal: 'maintain', diet: 'pescatarian' },
    expect: { age: 34, bmi: 22.5, bmr: 1381.5, tdee: 2141.3, calories: 2141, proteinG: 118, carbsG: 267, fatG: 67, activity: 'moderate' },
  },
  {
    name: '"other", birthday is tomorrow (still 25), gain, vegetarian',
    input: { sex: 'other', birthDate: '2000-10-07', heightCm: 172, weightKg: 68, workoutsPerWeek: 'moderate', goal: 'gain', diet: 'vegetarian' },
    expect: { age: 25, bmi: 23, bmr: 1552, tdee: 2405.6, calories: 2646, proteinG: 119, carbsG: 376, fatG: 74, activity: 'moderate' },
  },
  {
    name: 'man, active, maintain, flexitarian',
    input: { sex: 'male', birthDate: '1980-12-12', heightCm: 178, weightKg: 82, workoutsPerWeek: 'heavy', goal: 'maintain', diet: 'flexitarian' },
    expect: { age: 45, bmi: 25.9, bmr: 1712.5, tdee: 2954.1, calories: 2954, proteinG: 148, carbsG: 406, fatG: 82, activity: 'heavy' },
  },
  {
    name: 'woman, active, lose, whole-food',
    input: { sex: 'female', birthDate: '1975-07-07', heightCm: 162, weightKg: 72, workoutsPerWeek: 'heavy', goal: 'lose', diet: 'whole_food' },
    expect: { age: 51, bmi: 27.4, bmr: 1316.5, tdee: 2271, calories: 1930, proteinG: 121, carbsG: 240, fatG: 54, activity: 'heavy' },
  },
  {
    name: 'woman, sedentary (1.2), maintain, balanced',
    input: { sex: 'female', birthDate: '1992-04-04', heightCm: 170, weightKg: 65, workoutsPerWeek: 'sedentary', goal: 'maintain', diet: 'balanced' },
    expect: { age: 34, bmi: 22.5, bmr: 1381.5, tdee: 1657.8, calories: 1658, proteinG: 91, carbsG: 220, fatG: 46, activity: 'sedentary' },
  },
  {
    name: 'man, athlete (1.9), maintain, balanced',
    input: { sex: 'male', birthDate: '1990-05-05', heightCm: 180, weightKg: 80, workoutsPerWeek: 'athlete', goal: 'maintain', diet: 'balanced' },
    expect: { age: 36, bmi: 24.7, bmr: 1750, tdee: 3325, calories: 3325, proteinG: 183, carbsG: 441, fatG: 92, activity: 'athlete' },
  },
];

describe('calculatePlan fixtures', () => {
  it.each(fixtures)('$name', ({ input, expect: e }) => {
    const plan = calculatePlan(input, cfg, NOW);
    expect(plan.ageYears).toBe(e.age);
    expect(plan.bmi).toBe(e.bmi);
    expect(plan.bmr).toBe(e.bmr);
    expect(plan.tdee).toBe(e.tdee);
    expect(plan.activityLevel).toBe(e.activity);
    expect([plan.calories, plan.proteinG, plan.carbsG, plan.fatG]).toEqual([e.calories, e.proteinG, e.carbsG, e.fatG]);
    expect(plan.healthScoreEnabled).toBe(true);
  });

  it('is deterministic', () => {
    const input = fixtures[0]!.input;
    expect(calculatePlan(input, cfg, NOW)).toEqual(calculatePlan(input, cfg, NOW));
  });
});

describe('invariants across every sex, goal, diet and activity bucket', () => {
  const base = { birthDate: '1992-03-03', heightCm: 172, weightKg: 70 };
  for (const sex of SEX) {
    for (const goal of GOALS) {
      for (const diet of DIETS) {
        for (const workoutsPerWeek of WORKOUTS_PER_WEEK) {
          const label = `${sex}/${goal}/${diet}/${workoutsPerWeek}`;
          it(label, () => {
            const p = calculatePlan({ ...base, sex, goal, diet, workoutsPerWeek }, cfg, NOW);
            // Macros convert back to the calorie target within rounding (4/4/9 kcal per gram).
            const kcal = p.proteinG * KCAL_PER_GRAM.protein + p.carbsG * KCAL_PER_GRAM.carbs + p.fatG * KCAL_PER_GRAM.fat;
            expect(Math.abs(kcal - p.calories)).toBeLessThanOrEqual(5);
            expect(p.proteinG).toBeGreaterThanOrEqual(0);
            expect(p.carbsG).toBeGreaterThanOrEqual(0);
            expect(p.fatG).toBeGreaterThanOrEqual(0);
            expect(p.calories).toBeGreaterThanOrEqual(cfg.limits.calories.min);
            expect(p.calories).toBeLessThanOrEqual(cfg.limits.calories.max);
          });
        }
      }
    }
  }

  it('lose < maintain < gain for the same person', () => {
    const input: PlanInput = { sex: 'female', birthDate: '1992-03-03', heightCm: 172, weightKg: 70, workoutsPerWeek: 'moderate', goal: 'maintain', diet: 'balanced' };
    const c = (goal: PlanInput['goal']) => calculatePlan({ ...input, goal }, cfg, NOW).calories;
    expect(c('lose')).toBeLessThan(c('maintain'));
    expect(c('maintain')).toBeLessThan(c('gain'));
  });

  it('more workouts never lower the target', () => {
    const input: PlanInput = { sex: 'male', birthDate: '1992-03-03', heightCm: 180, weightKg: 80, workoutsPerWeek: 'light', goal: 'maintain', diet: 'balanced' };
    const c = (w: PlanInput['workoutsPerWeek']) => calculatePlan({ ...input, workoutsPerWeek: w }, cfg, NOW).calories;
    expect(c('sedentary')).toBeLessThan(c('light'));
    expect(c('light')).toBeLessThan(c('moderate'));
    expect(c('moderate')).toBeLessThan(c('heavy'));
    expect(c('heavy')).toBeLessThan(c('athlete'));
  });

  it('every diet split adds up to 100% of calories', () => {
    for (const diet of DIETS) {
      const s = cfg.macroSplit[diet];
      expect(s.protein + s.carbs + s.fat).toBeCloseTo(1, 10);
    }
  });

  it('keto and low-carb push carbs down and fat up; vegan has less protein than balanced', () => {
    const share = (diet: PlanInput['diet']) => {
      const p = calculatePlan({ sex: 'male', birthDate: '1992-03-03', heightCm: 180, weightKg: 80, workoutsPerWeek: 'moderate', goal: 'maintain', diet }, cfg, NOW);
      return { carbs: (p.carbsG * 4) / p.calories, fat: (p.fatG * 9) / p.calories, protein: (p.proteinG * 4) / p.calories };
    };
    expect(share('keto').carbs).toBeLessThan(0.1);
    expect(share('low_carb').carbs).toBeLessThan(share('balanced').carbs);
    expect(share('keto').fat).toBeGreaterThan(share('balanced').fat);
    expect(share('vegan').protein).toBeLessThan(share('balanced').protein);
  });
});

describe('the balanced split matches the design mock-up (about 21 / 53 / 25)', () => {
  it('for a 1288 kcal target', () => {
    // Mock-up: 1288 kcal, 69 g protein, 172 g carbs, 36 g fat. Ours lands within 3 g of every figure.
    const p = calculatePlan(
      { sex: 'female', birthDate: '2001-01-01', heightCm: 160, weightKg: 45, workoutsPerWeek: 'light', goal: 'maintain', diet: 'balanced' },
      { ...cfg, activityMultiplier: { ...cfg.activityMultiplier, light: 1288 / (10 * 45 + 6.25 * 160 - 5 * 25 - 161) } },
      NOW,
    );
    expect(p.calories).toBe(1288);
    expect(Math.abs(p.proteinG - 69)).toBeLessThanOrEqual(3);
    expect(Math.abs(p.carbsG - 172)).toBeLessThanOrEqual(3);
    expect(Math.abs(p.fatG - 36)).toBeLessThanOrEqual(3);
  });
});

describe('guardrails', () => {
  const ok: PlanInput = { sex: 'female', birthDate: '2001-01-01', heightCm: 167.6, weightKg: 54, workoutsPerWeek: 'light', goal: 'maintain', diet: 'balanced' };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof AppError) return `${e.status} ${e.code}`;
      throw e;
    }
    return 'no error';
  };

  it('refuses users under 13 and accepts a 13th birthday', () => {
    expect(code(() => calculatePlan({ ...ok, birthDate: '2013-10-07' }, cfg, NOW))).toBe('422 UNDER_MINIMUM_AGE');
    expect(code(() => calculatePlan({ ...ok, birthDate: '2013-10-06' }, cfg, NOW))).toBe('no error');
  });

  it('refuses an impossible age', () => {
    expect(code(() => calculatePlan({ ...ok, birthDate: '1890-01-01' }, cfg, NOW))).toBe('422 INVALID_BIRTH_DATE');
  });

  it('refuses a "lose" plan when BMI < 18.5, but not maintain or gain', () => {
    const slim = { ...ok, weightKg: 45 }; // BMI 16.0
    expect(code(() => calculatePlan({ ...slim, goal: 'lose' }, cfg, NOW))).toBe('422 GOAL_NOT_SUPPORTED');
    expect(code(() => calculatePlan({ ...slim, goal: 'maintain' }, cfg, NOW))).toBe('no error');
    expect(code(() => calculatePlan({ ...slim, goal: 'gain' }, cfg, NOW))).toBe('no error');
  });

  it('allows "lose" at exactly the BMI boundary', () => {
    const w = 18.5 * 1.7 * 1.7;
    expect(code(() => calculatePlan({ ...ok, heightCm: 170, weightKg: w + 0.01, goal: 'lose' }, cfg, NOW))).toBe('no error');
    expect(code(() => calculatePlan({ ...ok, heightCm: 170, weightKg: w - 0.2, goal: 'lose' }, cfg, NOW))).toBe('422 GOAL_NOT_SUPPORTED');
  });

  it('refuses a lose target that is not below the current weight, or that is underweight', () => {
    const lose: PlanInput = { ...ok, weightKg: 70, goal: 'lose' };
    expect(code(() => calculatePlan({ ...lose, targetWeightKg: 70 }, cfg, NOW))).toBe('422 INVALID_TARGET_WEIGHT');
    expect(code(() => calculatePlan({ ...lose, targetWeightKg: 60 }, cfg, NOW))).toBe('no error');
    expect(code(() => calculatePlan({ ...lose, targetWeightKg: 45 }, cfg, NOW))).toBe('422 GOAL_NOT_SUPPORTED');
  });

  it('refuses a gain target that is not above the current weight', () => {
    expect(code(() => calculatePlan({ ...ok, goal: 'gain', targetWeightKg: 50 }, cfg, NOW))).toBe('422 INVALID_TARGET_WEIGHT');
    expect(code(() => calculatePlan({ ...ok, goal: 'gain', targetWeightKg: 58 }, cfg, NOW))).toBe('no error');
  });

  it('never goes under the floor, and floors are configurable', () => {
    const tiny: PlanInput = { sex: 'female', birthDate: '1966-02-02', heightCm: 150, weightKg: 42, workoutsPerWeek: 'light', goal: 'lose', diet: 'balanced' };
    expect(calculatePlan(tiny, cfg, NOW).calories).toBe(1200);
    const strict = { ...cfg, loseCalorieFloor: { ...cfg.loseCalorieFloor, female: 1350 } };
    expect(calculatePlan(tiny, strict, NOW).calories).toBe(1350);
  });
});

describe('projection', () => {
  const input: PlanInput = { sex: 'male', birthDate: '1990-01-01', heightCm: 180, weightKg: 90, workoutsPerWeek: 'moderate', goal: 'lose', diet: 'balanced', targetWeightKg: 80 };

  it('returns the 3 / 7 / 30 day points, rising monotonically to the goal at day 30', () => {
    const { projection } = calculatePlan(input, cfg, NOW);
    expect(projection.map((p) => [p.day, p.progress])).toEqual([[3, 0.1], [7, 0.35], [30, 1]]);
    for (let i = 1; i < projection.length; i++) expect(projection[i]!.progress).toBeGreaterThan(projection[i - 1]!.progress);
    // The biggest jump is between day 7 and day 30, which is how the chart reads (labels are evenly spaced).
    // Note: per day, 3->7 (0.0625) is steeper than 7->30 (0.028). The constants live in config/plan.ts.
    const gains = projection.map((p, i) => p.progress - (projection[i - 1]?.progress ?? 0));
    expect(gains[2]).toBeGreaterThan(gains[1]!);
    expect(gains[1]).toBeGreaterThan(gains[0]!);
  });

  it('turns progress into weights toward the target', () => {
    const { projection } = calculatePlan(input, cfg, NOW);
    expect(projection.map((p) => p.projectedWeightKg)).toEqual([89, 86.5, 80]);
  });

  it('is flat for maintain, and null without a target for lose/gain', () => {
    const maintain = calculatePlan({ ...input, goal: 'maintain', targetWeightKg: null }, cfg, NOW);
    expect(maintain.projection.every((p) => p.projectedWeightKg === 90)).toBe(true);
    expect(maintain.targetWeightKg).toBe(90);
    const noTarget = calculatePlan({ ...input, targetWeightKg: null }, cfg, NOW);
    expect(noTarget.projection.every((p) => p.projectedWeightKg === null)).toBe(true);
  });

  it('points are configurable', () => {
    const custom = { ...cfg, projection: [{ day: 5, progress: 0.2 }, { day: 14, progress: 0.6 }] };
    expect(calculatePlan(input, custom, NOW).projection).toHaveLength(2);
  });
});

describe('clampGoal', () => {
  const base = { calories: 2000, proteinG: 150, carbsG: 200, fatG: 60 };
  it('keeps omitted fields and rounds to whole numbers', () => {
    expect(clampGoal({ proteinG: 120.6 }, base, cfg.limits)).toEqual({ ...base, proteinG: 121 });
  });
  it('clamps calories to 800-6000 and macros to non-negative', () => {
    expect(clampGoal({ calories: 100 }, base, cfg.limits).calories).toBe(800);
    expect(clampGoal({ calories: 9000 }, base, cfg.limits).calories).toBe(6000);
    expect(clampGoal({ proteinG: -3, carbsG: -1, fatG: -9 }, base, cfg.limits)).toMatchObject({ proteinG: 0, carbsG: 0, fatG: 0 });
  });
});

describe('helpers', () => {
  it('calculateAge handles leap days and birthdays exactly', () => {
    expect(calculateAge('2000-02-29', new Date('2026-02-28T00:00:00Z'))).toBe(25);
    expect(calculateAge('2000-02-29', new Date('2026-03-01T00:00:00Z'))).toBe(26);
    expect(calculateAge('2000-10-06', NOW)).toBe(26);
    expect(calculateAge('2000-10-07', NOW)).toBe(25);
  });
  it('calculateBmi', () => {
    expect(calculateBmi(70, 175)).toBeCloseTo(22.86, 2);
  });
});
