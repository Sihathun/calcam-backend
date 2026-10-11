import { authRoute, type RouteDef } from '../../lib/http/route';
import { foodListSchema } from './foods.schemas';
import type { FoodsService } from './foods.service';

export function foodsRoutes(svc: FoodsService): RouteDef[] {
  return [
    authRoute({
      method: 'get',
      path: '/foods',
      tags: ['Foods'],
      summary: 'The food list: every catalog food with its nutrition',
      description:
        'Powers the "choose a food" screen. Returns every reviewed catalog food (not the dishes the AI learned) with calories, protein, carbs and fat for one standard serving, and a photo URL when there is one. Where the user has corrected a food before, their own values are returned and `personal` is true. `recent` lists the slugs the user logged most recently. Log a food with POST /meals/from-food.',
      responses: { 200: { description: 'The catalog', schema: foodListSchema } },
      handler: async ({ user }) => svc.list(user),
    }),
  ];
}
