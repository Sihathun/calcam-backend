import { z } from 'zod';

/**
 * Shape sent to providers that support structured output. Kept free of min/max keywords,
 * which structured-output schema compilers reject. Real limits are enforced by aiMealSchema.
 */
export const aiMealWireSchema = z.object({
  name: z.string().describe('Short, human-friendly dish name in Title Case'),
  items: z.array(
    z.object({
      name: z.string(),
      portion: z.string().describe('Estimated portion, e.g. "1 sandwich" or "40 g"'),
      calories: z.number(),
      proteinG: z.number(),
      carbsG: z.number(),
      fatG: z.number(),
    }),
  ),
  calories: z.number().describe('Total kcal for everything in the photo'),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
  healthScore: z.number().describe('Integer 0-10, 10 is the healthiest'),
  isFood: z.boolean(),
  confidence: z.number().describe('0-1, how sure you are about the estimate'),
});

const nonNegative = z.number().finite().min(0);

/** The strict contract the worker validates every provider response against. */
export const aiMealSchema = z.object({
  name: z.string().max(200),
  items: z
    .array(
      z.object({
        name: z.string().max(200),
        portion: z.string().max(100).default(''),
        calories: nonNegative,
        proteinG: nonNegative,
        carbsG: nonNegative,
        fatG: nonNegative,
      }),
    )
    .max(40),
  calories: nonNegative,
  proteinG: nonNegative,
  carbsG: nonNegative,
  fatG: nonNegative,
  healthScore: z.number().finite().min(0).max(10),
  isFood: z.boolean(),
  confidence: z.number().finite().min(0).max(1),
});

export type AiMeal = z.infer<typeof aiMealSchema>;

export interface NormalizedMeal {
  name: string;
  items: { name: string; portion: string; calories: number; proteinG: number; carbsG: number; fatG: number }[];
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  healthScore: number;
  isFood: boolean;
  confidence: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const MAX_MACRO_G = 1000;

/** Clamps implausible values (a model can hallucinate 90000 kcal) and rounds to storage precision. */
export function normalizeMeal(ai: AiMeal, maxCalories: number): NormalizedMeal {
  const kcal = (n: number) => Math.min(Math.round(n), maxCalories);
  const grams = (n: number) => Math.min(round1(n), MAX_MACRO_G);
  return {
    name: ai.name.trim() || 'Meal',
    items: ai.items.map((i) => ({
      name: i.name,
      portion: i.portion,
      calories: kcal(i.calories),
      proteinG: grams(i.proteinG),
      carbsG: grams(i.carbsG),
      fatG: grams(i.fatG),
    })),
    calories: kcal(ai.calories),
    proteinG: grams(ai.proteinG),
    carbsG: grams(ai.carbsG),
    fatG: grams(ai.fatG),
    healthScore: Math.round(ai.healthScore),
    isFood: ai.isFood,
    confidence: ai.confidence,
  };
}
