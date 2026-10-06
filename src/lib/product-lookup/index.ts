import type { Config } from '../../config/env';
import type { Cache } from '../cache';
import { AppError } from '../errors';

export interface ProductInfo {
  barcode: string;
  name: string;
  brand: string | null;
  /** Human text such as "30 g". */
  servingSize: string | null;
  /** Per serving. When the product has no serving size, per 100 g. */
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** 0-10, derived from the Nutri-Score when present. */
  healthScore: number | null;
  imageUrl: string | null;
}

export interface ProductLookup {
  findByBarcode(barcode: string): Promise<ProductInfo | null>;
}

const NUTRISCORE_TO_HEALTH: Record<string, number> = { a: 10, b: 8, c: 6, d: 4, e: 2 };

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Converts an Open Food Facts product document into per-serving nutrition. Returns null if calories are unknown. */
export function parseOffProduct(barcode: string, product: Record<string, any>): ProductInfo | null {
  const n: Record<string, unknown> = product.nutriments ?? {};
  const servingG = num(product.serving_quantity);

  const kcal100 = num(n['energy-kcal_100g']) ?? (num(n['energy_100g']) !== undefined ? num(n['energy_100g'])! / 4.184 : undefined);
  const perServing = (servingKey: string, per100Key: string, per100Fallback?: number): number | undefined => {
    const direct = num(n[servingKey]);
    if (direct !== undefined) return direct;
    const per100 = per100Fallback ?? num(n[per100Key]);
    if (per100 === undefined) return undefined;
    return servingG ? (per100 * servingG) / 100 : per100;
  };

  const calories = perServing('energy-kcal_serving', 'energy-kcal_100g', kcal100);
  if (calories === undefined) return null;

  const name = String(product.product_name ?? '').trim();
  const brand = String(product.brands ?? '').split(',')[0]?.trim() || null;
  const grade = String(product.nutriscore_grade ?? '').toLowerCase();

  return {
    barcode,
    name: name || brand || `Product ${barcode}`,
    brand,
    servingSize: product.serving_size ? String(product.serving_size) : servingG ? `${servingG} g` : '100 g',
    calories: Math.round(calories),
    proteinG: Math.round((perServing('proteins_serving', 'proteins_100g') ?? 0) * 10) / 10,
    carbsG: Math.round((perServing('carbohydrates_serving', 'carbohydrates_100g') ?? 0) * 10) / 10,
    fatG: Math.round((perServing('fat_serving', 'fat_100g') ?? 0) * 10) / 10,
    healthScore: NUTRISCORE_TO_HEALTH[grade] ?? null,
    imageUrl: typeof product.image_front_small_url === 'string' ? product.image_front_small_url : null,
  };
}

export class OpenFoodFactsLookup implements ProductLookup {
  constructor(private readonly config: Config) {}

  async findByBarcode(barcode: string): Promise<ProductInfo | null> {
    const fields = 'product_name,brands,serving_size,serving_quantity,nutriments,nutriscore_grade,image_front_small_url';
    const url = `${this.config.productLookup.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': `${this.config.appName.replace(/\s+/g, '')}/1.0 (backend)` },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError(502, 'PRODUCT_LOOKUP_UNAVAILABLE', 'The product database is not reachable right now');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError(502, 'PRODUCT_LOOKUP_UNAVAILABLE', 'The product database is not reachable right now');
    const json = (await res.json()) as { status?: number; product?: Record<string, any> };
    if (json.status === 0 || !json.product) return null;
    return parseOffProduct(barcode, json.product);
  }
}

/** Caches hits for the configured TTL and misses for an hour, so repeated scans do not hammer the upstream API. */
export class CachedProductLookup implements ProductLookup {
  constructor(
    private readonly inner: ProductLookup,
    private readonly cache: Cache,
    private readonly ttlSeconds: number,
  ) {}

  async findByBarcode(barcode: string): Promise<ProductInfo | null> {
    const key = `product:${barcode}`;
    const hit = await this.cache.get<{ product: ProductInfo | null }>(key);
    if (hit) return hit.product;
    const product = await this.inner.findByBarcode(barcode);
    await this.cache.set(key, { product }, product ? this.ttlSeconds : Math.min(this.ttlSeconds, 3600));
    return product;
  }
}
