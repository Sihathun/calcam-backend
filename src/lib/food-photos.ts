import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Photos of catalog foods: prisma/data/food-photos/<slug>.webp, written by `npm run foods:photos` and served by
 * the API under /food-photos. A food without a file simply has no photo (the app shows an icon).
 */
export const FOOD_PHOTO_DIR = resolve(__dirname, '../../prisma/data/food-photos');
export const FOOD_PHOTO_ROUTE = '/food-photos';

let slugs: Set<string> | null = null;

/** The path a food's photo is served at ("/food-photos/bai-cha.webp"), or null when there is none. */
export function foodPhotoPath(slug: string): string | null {
  if (!slugs) {
    try {
      slugs = new Set(readdirSync(FOOD_PHOTO_DIR).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -'.webp'.length)));
    } catch {
      slugs = new Set();
    }
  }
  return slugs.has(slug) ? `${FOOD_PHOTO_ROUTE}/${slug}.webp` : null;
}
