import type { AppDeps } from '../../deps';
import { foodPhotoPath } from '../../lib/food-photos';
import type { AuthUser } from '../../lib/http/route';
import type { FoodDto } from './foods.schemas';

const RECENT_LIMIT = 8;
/** Recent foods come from the user's latest meal components; a few extra rows cover repeats of the same food. */
const RECENT_SCAN_ROWS = 60;

export function createFoodsService(deps: AppDeps) {
  const { prisma, config } = deps;

  /** Slugs the user logged lately (scans and picks alike), catalog foods only. */
  async function recentSlugs(userId: string): Promise<string[]> {
    const rows = await prisma.mealComponent.findMany({
      where: { dish: { kind: 'catalog' }, meal: { userId, deletedAt: null, status: 'completed' } },
      orderBy: [{ meal: { loggedAt: 'desc' } }, { position: 'asc' }],
      take: RECENT_SCAN_ROWS,
      select: { dish: { select: { slug: true } } },
    });
    return [...new Set(rows.map((r) => r.dish.slug))].slice(0, RECENT_LIMIT);
  }

  return {
    /** GET /foods: the whole catalog (never learned dishes) with this user's own values where they corrected one. */
    async list(user: AuthUser): Promise<{ items: FoodDto[]; recent: string[] }> {
      const [dishes, overrides, recent] = await Promise.all([
        prisma.foodDish.findMany({ where: { kind: 'catalog' }, orderBy: [{ category: 'asc' }, { nameEn: 'asc' }] }),
        prisma.userDishOverride.findMany({ where: { userId: user.id } }),
        recentSlugs(user.id),
      ]);
      const own = new Map(overrides.map((o) => [o.dishId, o]));
      const items = dishes.map((d) => {
        const ref = own.get(d.id) ?? d;
        const photo = foodPhotoPath(d.slug);
        return {
          slug: d.slug,
          nameEn: d.nameEn,
          nameKm: d.nameKm,
          aliases: d.aliases,
          category: d.category,
          servingDescription: d.servingDescription,
          servingGrams: d.servingGrams,
          calories: ref.calories,
          proteinG: ref.proteinG,
          carbsG: ref.carbsG,
          fatG: ref.fatG,
          healthScore: d.healthScore,
          photoUrl: photo ? `${config.publicBaseUrl}${photo}` : null,
          personal: own.has(d.id),
        };
      });
      return { items, recent };
    },
  };
}

export type FoodsService = ReturnType<typeof createFoodsService>;
