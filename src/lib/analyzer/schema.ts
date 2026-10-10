import { z } from 'zod';

/**
 * Portion steps the model may answer with, as multiples of the dish's standard serving. A small fixed set
 * repeats far more reliably than free numbers: the same plate keeps getting the same step.
 */
export const PORTION_STEPS = ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '3'] as const;
export const NEW_DISH = 'new';
const MAX_DISHES = 6;

const servingWire = z.object({
  description: z.string().describe('One standard serving of this dish as sold in Cambodia, e.g. "1 bowl (about 450 g)"'),
  calories: z.number().describe('kcal for ONE standard serving'),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
  healthScore: z.number().describe('Integer 0-10, 10 is the healthiest'),
});

/**
 * Shape sent to providers that support structured output (prompt meal-analysis.v2). Kept free of min/max
 * keywords, which structured-output schema compilers reject. Real limits are enforced by aiMealSchema.
 */
export const aiMealWireSchema = z.object({
  isFood: z.boolean(),
  confidence: z.number().describe('0-1, how sure you are about the dishes and portions'),
  dishes: z.array(
    z.object({
      match: z.string().describe('The slug of the listed dish this is, or "new" if none of them fits'),
      nameEn: z.string().describe('Dish name in English, Title Case'),
      nameKm: z.string().describe('Dish name in Khmer script'),
      portion: z.enum(PORTION_STEPS).describe('Size compared with the standard serving'),
      standardServing: servingWire,
    }),
  ),
});

const nonNegative = z.number().finite().min(0);

/** The strict contract the worker validates every provider response against. */
export const aiMealSchema = z.object({
  isFood: z.boolean(),
  confidence: z.number().finite().min(0).max(1),
  dishes: z
    .array(
      z.object({
        match: z.string().trim().max(120),
        nameEn: z.string().trim().max(200),
        nameKm: z.string().trim().max(200).default(''),
        portion: z.union([z.enum(PORTION_STEPS), z.number().finite().positive()]),
        standardServing: z.object({
          description: z.string().max(200).default('1 serving'),
          calories: nonNegative,
          proteinG: nonNegative,
          carbsG: nonNegative,
          fatG: nonNegative,
          healthScore: z.number().finite().min(0).max(10),
        }),
      }),
    )
    .max(MAX_DISHES),
});

export type AiMeal = z.infer<typeof aiMealSchema>;
export type AiDish = AiMeal['dishes'][number];

const STEP_VALUES = PORTION_STEPS.map(Number);

/** The nearest allowed portion step (a model may still answer 1.4 or "1.25"). */
export function snapPortion(portion: string | number): number {
  const value = Number(portion);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return STEP_VALUES.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best), 1);
}
