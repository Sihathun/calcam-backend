import { z } from 'zod';
import { dateOnly, isoInput, isoOutput } from '../../lib/dto';
import { MEAL_ERROR_CODES, mealSourceSchema, mealStatusSchema } from '../../lib/enums';

const quantity = z.number().min(0.25).max(20);

// ---------- responses ----------

const nullableNutrition = z.object({
  calories: z.number().int().nullable(),
  proteinG: z.number().nullable(),
  carbsG: z.number().nullable(),
  fatG: z.number().nullable(),
});

export const mealItemSchema = z.object({
  name: z.string(),
  portion: z.string(),
  calories: z.number(),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
});

/** One dish the analysis recognised in the meal, with the nutrition it contributes per serving of the meal. */
export const mealComponentSchema = z.object({
  dishSlug: z.string(),
  nameEn: z.string(),
  nameKm: z.string().nullable(),
  /** Multiple of the dish's standard serving, e.g. 1.5. */
  portion: z.number(),
  calories: z.number().int(),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
  /** Where the reference values came from: the catalog, a learned dish, or this user's own correction. */
  valueSource: z.enum(['catalog', 'learned', 'personal']),
});
export type MealComponentDto = z.infer<typeof mealComponentSchema>;

/** Compact form used by lists and the Home screen's "Recently eaten" cards. Nutrition fields are totals. */
export const mealSummarySchema = z.object({
  id: z.uuid(),
  /** Null while the first analysis is running; the client shows "Analyzing food...". */
  name: z.string().nullable(),
  /** Khmer name, when the dishes have one. */
  nameKm: z.string().nullable(),
  source: mealSourceSchema,
  status: mealStatusSchema,
  /** Stage-based, not smooth: queued 5, image ready 20, model answered 50, validated 90, completed 100. */
  progress: z.number().int(),
  errorCode: z.enum(MEAL_ERROR_CODES).nullable(),
  thumbnailUrl: z.string().nullable(),
  loggedAt: isoOutput,
  quantity: z.number(),
  calories: z.number().int().nullable(),
  proteinG: z.number().nullable(),
  carbsG: z.number().nullable(),
  fatG: z.number().nullable(),
  healthScore: z.number().int().nullable(),
});
export type MealSummary = z.infer<typeof mealSummarySchema>;

/** Everything the Nutrition detail screen needs. */
export const mealDetailSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  nameKm: z.string().nullable(),
  source: mealSourceSchema,
  status: mealStatusSchema,
  progress: z.number().int(),
  /** Set when the last analysis failed. On a meal that still has earlier values (a failed "Fix Results") the meal stays `completed`. */
  errorCode: z.enum(MEAL_ERROR_CODES).nullable(),
  /** True while "Fix Results" is re-analyzing: the previous values are still shown and still counted. */
  reanalyzing: z.boolean(),
  imageUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  loggedAt: isoOutput,
  createdAt: isoOutput,
  quantity: z.number(),
  perServing: nullableNutrition,
  totals: nullableNutrition,
  healthScore: z.number().int().nullable(),
  items: z.array(mealItemSchema).nullable(),
  /** The recognised dishes. Empty for manual and barcode meals, and while the first analysis runs. */
  components: z.array(mealComponentSchema),
  barcode: z.string().nullable(),
});
export type MealDetail = z.infer<typeof mealDetailSchema>;

export const mealEnvelopeSchema = z.object({ meal: mealDetailSchema });

export const mealListSchema = z.object({
  items: z.array(mealSummarySchema),
  nextCursor: z.string().nullable(),
});

// ---------- requests ----------

/** Multipart text fields that accompany the image. */
/** Seconds the upload request may wait for the analysis to finish before answering 202 (spec 0003). */
export const MAX_ANALYZE_WAIT_S = 25;
const waitSeconds = z.coerce.number().int().min(0).max(MAX_ANALYZE_WAIT_S).optional();

export const analyzeFieldsSchema = z.object({
  loggedAt: isoInput.optional(),
  source: z.enum(['camera', 'gallery']).optional(),
  hint: z.string().trim().max(300).optional(),
  wait: waitSeconds.describe('Wait up to this many seconds for the result (0 to 25). Answers 200 when it is ready.'),
});

export const analyzeQuerySchema = z.object({ wait: waitSeconds });

export const barcodeBodySchema = z.object({
  barcode: z.string().regex(/^\d{8,14}$/, 'Expected 8 to 14 digits'),
  loggedAt: isoInput.optional(),
  quantity: quantity.optional(),
});

/**
 * Two shapes in one object so validation errors name the exact missing field:
 *  - manual entry: name, calories, proteinG, carbsG, fatG (+ optional quantity)
 *  - text estimate: description (the AI estimates the nutrition, so the other fields must be absent)
 */
export const createMealBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    calories: z.number().int().min(0).max(10000).optional(),
    proteinG: z.number().min(0).max(1000).optional(),
    carbsG: z.number().min(0).max(1000).optional(),
    fatG: z.number().min(0).max(1000).optional(),
    quantity: quantity.optional(),
    description: z.string().trim().min(2).max(500).optional().describe('Queues an AI estimate instead of manual values'),
    loggedAt: isoInput.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.description !== undefined) return;
    for (const key of ['name', 'calories', 'proteinG', 'carbsG', 'fatG'] as const) {
      if (v[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'Required for manual entry (or send a description)' });
    }
  });

/** Logs one catalog food. The food's values for one standard serving are copied into the meal. */
export const fromFoodBodySchema = z.object({
  dishSlug: z.string().trim().min(1).max(120),
  quantity: quantity.optional(),
  loggedAt: isoInput.optional(),
});

export const patchMealBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    calories: z.number().int().min(0).max(10000),
    proteinG: z.number().min(0).max(1000),
    carbsG: z.number().min(0).max(1000),
    fatG: z.number().min(0).max(1000),
    quantity,
    loggedAt: isoInput,
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to change');

export const fixBodySchema = z.object({
  instruction: z.string().trim().min(2).max(500),
});

export const dateParamSchema = z.union([z.enum(['today', 'yesterday']), dateOnly]);

export const listQuerySchema = z.object({
  date: dateParamSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(300).optional(),
});
