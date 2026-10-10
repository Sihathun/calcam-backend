import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

/**
 * The Khmer food catalog: prisma/data/khmer-dishes.json, reviewed in git with a source per dish. Values are
 * for ONE standard serving. `npm run catalog:seed` upserts it into FoodDish (kind = catalog); running it again
 * updates the values, and meals logged earlier keep the numbers they were saved with.
 */
export const CATALOG_FILE = resolve(__dirname, '../../prisma/data/khmer-dishes.json');

const catalogEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  nameEn: z.string().min(1),
  nameKm: z.string().min(1),
  aliases: z.array(z.string()),
  category: z.string(),
  servingDescription: z.string().min(1),
  servingGrams: z.number().positive(),
  calories: z.number().int().min(0),
  proteinG: z.number().min(0),
  carbsG: z.number().min(0),
  fatG: z.number().min(0),
  healthScore: z.number().int().min(0).max(10),
  confidence: z.enum(['high', 'medium', 'low']),
  method: z.string(),
  sources: z.array(z.object({ name: z.string(), url: z.string().optional() })),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Lowercase ASCII words only: "Pork & Rice (Bai Sach Chrouk)" -> "pork rice bai sach chrouk". */
export function normalizeDishName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/\band\b|\bwith\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function loadCatalog(file = CATALOG_FILE): CatalogEntry[] {
  const entries = z.array(catalogEntrySchema).parse(JSON.parse(readFileSync(file, 'utf8')));
  const slugs = new Set<string>();
  for (const e of entries) {
    if (slugs.has(e.slug)) throw new Error(`Duplicate catalog slug: ${e.slug}`);
    slugs.add(e.slug);
  }
  return entries;
}

/** Inserts or updates every catalog dish by slug. Returns how many were written. */
export async function seedCatalog(prisma: PrismaClient, entries = loadCatalog()): Promise<number> {
  for (const e of entries) {
    const data = {
      kind: 'catalog' as const,
      nameEn: e.nameEn,
      nameKm: e.nameKm,
      normalizedName: normalizeDishName(e.nameEn),
      aliases: e.aliases.map(normalizeDishName),
      category: e.category,
      servingDescription: e.servingDescription,
      servingGrams: e.servingGrams,
      calories: e.calories,
      proteinG: e.proteinG,
      carbsG: e.carbsG,
      fatG: e.fatG,
      healthScore: e.healthScore,
      confidence: e.confidence,
      sources: { method: e.method, sources: e.sources },
    };
    await prisma.foodDish.upsert({ where: { slug: e.slug }, create: { slug: e.slug, ...data }, update: data });
  }
  return entries.length;
}
