import type { Meal, PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/storage';
import { mealTotals } from '../../lib/nutrition';
import type { MealComponentDto, MealDetail, MealSummary } from './meals.schemas';

type MealErrorCode = NonNullable<MealSummary['errorCode']>;

export function createMealMapper(storage: ObjectStorage, prisma: PrismaClient, publicBaseUrl: string) {
  /** A stored path like "/food-photos/bai-cha.webp" is one of our own files; anything else is a full URL. */
  const external = (m: Meal) =>
    m.externalImageUrl?.startsWith('/') ? `${publicBaseUrl}${m.externalImageUrl}` : (m.externalImageUrl ?? null);
  const thumb = async (m: Meal) => (m.thumbKey ? storage.signedUrl(m.thumbKey) : external(m));
  const image = async (m: Meal) => (m.imageKey ? storage.signedUrl(m.imageKey) : external(m));

  return {
    async summary(m: Meal): Promise<MealSummary> {
      const t = mealTotals(m);
      return {
        id: m.id,
        name: m.name,
        nameKm: m.nameKm,
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
      const rows = await prisma.mealComponent.findMany({
        where: { mealId: m.id },
        orderBy: { position: 'asc' },
        include: { dish: true },
      });
      const components: MealComponentDto[] = rows.map((c) => ({
        dishSlug: c.dish.slug,
        nameEn: c.dish.nameEn,
        nameKm: c.dish.nameKm,
        portion: c.portion,
        calories: c.calories,
        proteinG: c.proteinG,
        carbsG: c.carbsG,
        fatG: c.fatG,
        valueSource: c.valueSource,
      }));
      return {
        id: m.id,
        name: m.name,
        nameKm: m.nameKm,
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
        components,
        barcode: m.barcode,
      };
    },
  };
}

export type MealMapper = ReturnType<typeof createMealMapper>;
