import { z } from 'zod';

/** One catalog food as the food picker shows it. Nutrition is for ONE standard serving. */
export const foodSchema = z.object({
  slug: z.string(),
  nameEn: z.string(),
  nameKm: z.string().nullable(),
  /** Lowercase ASCII search terms: romanized Khmer and other English names. */
  aliases: z.array(z.string()),
  /** For example `rice_dish`, `noodle_dish`, `dessert`, or `ingredient` for a plain single food. */
  category: z.string().nullable(),
  servingDescription: z.string(),
  servingGrams: z.number().nullable(),
  calories: z.number().int(),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
  healthScore: z.number().int(),
  /** Absolute URL of a small WebP, or null when the food has no photo. */
  photoUrl: z.string().nullable(),
  /** True when the values are this user's own correction of the catalog values. */
  personal: z.boolean(),
});
export type FoodDto = z.infer<typeof foodSchema>;

export const foodListSchema = z.object({
  items: z.array(foodSchema),
  /** Slugs of the foods this user logged most recently, newest first, without repeats. */
  recent: z.array(z.string()),
});
