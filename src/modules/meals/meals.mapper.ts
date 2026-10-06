import type { Meal } from '@prisma/client';
import type { ObjectStorage } from '../../lib/storage';
import { mealTotals } from '../../lib/nutrition';
import type { MealDetail, MealSummary } from './meals.schemas';

type MealErrorCode = NonNullable<MealSummary['errorCode']>;

export function createMealMapper(storage: ObjectStorage) {
  const thumb = async (m: Meal) => (m.thumbKey ? storage.signedUrl(m.thumbKey) : (m.externalImageUrl ?? null));
  const image = async (m: Meal) => (m.imageKey ? storage.signedUrl(m.imageKey) : (m.externalImageUrl ?? null));

  return {
    async summary(m: Meal): Promise<MealSummary> {
      const t = mealTotals(m);
      return {
        id: m.id,
        name: m.name,
        source: m.source,
        status: m.status,
        progress: m.progress,
        errorCode: m.errorCode as MealErrorCode | null,
        thumbnailUrl: await thumb(m),
        loggedAt: m.loggedAt.toISOString(),
        quantity: m.quantity,
        calories: t?.calories ?? null,
        proteinG: t?.proteinG ?? null,
        carbsG: t?.carbsG ?? null,
        fatG: t?.fatG ?? null,
        healthScore: m.healthScore,
      };
    },

    async detail(m: Meal): Promise<MealDetail> {
      const t = mealTotals(m);
      return {
        id: m.id,
        name: m.name,
        source: m.source,
        status: m.status,
        progress: m.progress,
        errorCode: m.errorCode as MealErrorCode | null,
        reanalyzing: m.analyzedAt !== null && (m.status === 'queued' || m.status === 'analyzing'),
        imageUrl: await image(m),
        thumbnailUrl: await thumb(m),
        loggedAt: m.loggedAt.toISOString(),
        createdAt: m.createdAt.toISOString(),
        quantity: m.quantity,
        perServing: { calories: m.calories, proteinG: m.proteinG, carbsG: m.carbsG, fatG: m.fatG },
        totals: t ?? { calories: null, proteinG: null, carbsG: null, fatG: null },
        healthScore: m.healthScore,
        items: (m.items as MealDetail['items']) ?? null,
        barcode: m.barcode,
      };
    },
  };
}

export type MealMapper = ReturnType<typeof createMealMapper>;
