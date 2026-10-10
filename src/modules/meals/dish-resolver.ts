import type { FoodDish, PrismaClient } from '@prisma/client';
import type { DishPromptEntry } from '../../lib/analyzer';
import { NEW_DISH, snapPortion, type AiDish } from '../../lib/analyzer/schema';
import { normalizeDishName } from '../../lib/catalog';

/** How many learned dishes (most used first) the prompt lists next to the catalog. */
const LEARNED_IN_PROMPT = 150;
const LIST_TTL_MS = 5 * 60_000;
const MAX_MACRO_G = 1000;

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface ResolvedComponent {
  dish: FoodDish;
  portion: number;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  healthScore: number;
  valueSource: 'catalog' | 'learned' | 'personal';
}

/**
 * Turns the model's answer (dish identity + portion step) into nutrition the server owns:
 *   reference = this user's correction for the dish, else the dish's own values (catalog or learned)
 *   component = reference x portion
 * The model's own numbers are only used once, to create a learned dish the first time it names a new one.
 */
export function createDishResolver(prisma: PrismaClient, opts: { maxCalories: number; now: () => Date }) {
  let cached: { at: number; entries: DishPromptEntry[] } | null = null;

  /** The dishes listed in the prompt: the whole catalog plus the most used learned dishes. */
  async function promptEntries(): Promise<DishPromptEntry[]> {
    if (cached && opts.now().getTime() - cached.at < LIST_TTL_MS) return cached.entries;
    const [catalog, learned] = await Promise.all([
      prisma.foodDish.findMany({ where: { kind: 'catalog' }, orderBy: { slug: 'asc' } }),
      prisma.foodDish.findMany({
        where: { kind: 'learned' },
        orderBy: [{ components: { _count: 'desc' } }, { createdAt: 'asc' }],
        take: LEARNED_IN_PROMPT,
      }),
    ]);
    const entries = [...catalog, ...learned].map((d) => ({
      slug: d.slug,
      nameEn: d.nameEn,
      nameKm: d.nameKm,
      serving: d.servingDescription,
    }));
    cached = { at: opts.now().getTime(), entries };
    return entries;
  }

  /** A listed slug, else an existing dish with the same normalized name or alias, else a new learned dish. */
  async function resolveDish(ai: AiDish, mealId: string): Promise<{ dish: FoodDish; created: boolean }> {
    if (ai.match && ai.match !== NEW_DISH) {
      const bySlug = await prisma.foodDish.findUnique({ where: { slug: ai.match } });
      if (bySlug) return { dish: bySlug, created: false };
    }
    const normalized = normalizeDishName(ai.nameEn) || 'meal';
    const known =
      (await prisma.foodDish.findUnique({ where: { normalizedName: normalized } })) ??
      (await prisma.foodDish.findFirst({ where: { aliases: { has: normalized } }, orderBy: { kind: 'asc' } }));
    if (known) return { dish: known, created: false };

    const s = ai.standardServing;
    const slug = `learned-${normalized.replace(/ /g, '-')}`.slice(0, 120);
    // Two scans naming the same new dish at once: one insert wins, the other reads the winner.
    const inserted = await prisma.foodDish.createMany({
      data: {
        slug,
        kind: 'learned',
        nameEn: ai.nameEn.trim() || 'Meal',
        nameKm: ai.nameKm.trim() || null,
        normalizedName: normalized,
        servingDescription: s.description || '1 serving',
        calories: Math.min(Math.round(s.calories), opts.maxCalories),
        proteinG: Math.min(round1(s.proteinG), MAX_MACRO_G),
        carbsG: Math.min(round1(s.carbsG), MAX_MACRO_G),
        fatG: Math.min(round1(s.fatG), MAX_MACRO_G),
        healthScore: Math.round(s.healthScore),
        createdFromMealId: mealId,
      },
      skipDuplicates: true,
    });
    const dish = await prisma.foodDish.findUnique({ where: { normalizedName: normalized } });
    if (!dish) throw new Error(`learned dish ${normalized} vanished`);
    return { dish, created: inserted.count === 1 };
  }

  /** Reference values (the user's own correction wins) times the portion. */
  async function compute(userId: string, picks: { dish: FoodDish; portion: number }[]): Promise<ResolvedComponent[]> {
    const overrides = await prisma.userDishOverride.findMany({
      where: { userId, dishId: { in: picks.map((p) => p.dish.id) } },
    });
    const byDish = new Map(overrides.map((o) => [o.dishId, o]));
    return picks.map(({ dish, portion }) => {
      const own = byDish.get(dish.id);
      const ref = own ?? dish;
      return {
        dish,
        portion,
        calories: Math.round(ref.calories * portion),
        proteinG: round1(ref.proteinG * portion),
        carbsG: round1(ref.carbsG * portion),
        fatG: round1(ref.fatG * portion),
        healthScore: dish.healthScore,
        valueSource: own ? 'personal' : dish.kind,
      };
    });
  }

  return {
    promptEntries,
    /** Resolves every dish in the answer, in order, with its portion snapped to an allowed step. */
    async resolve(userId: string, mealId: string, dishes: AiDish[]) {
      const picks: { dish: FoodDish; portion: number }[] = [];
      let learnedCreated = false;
      for (const ai of dishes) {
        const { dish, created } = await resolveDish(ai, mealId);
        learnedCreated ||= created;
        picks.push({ dish, portion: snapPortion(ai.portion) });
      }
      // A new learned dish should be offered to the next prompt straight away.
      if (learnedCreated) cached = null;
      return compute(userId, picks);
    },
    compute,
  };
}

export type DishResolver = ReturnType<typeof createDishResolver>;

/** Meal per serving values from its components (AC: totals are the sum; health score is calorie weighted). */
export function summarize(components: ResolvedComponent[], maxCalories: number) {
  const sum = (k: 'calories' | 'proteinG' | 'carbsG' | 'fatG') => components.reduce((s, c) => s + c[k], 0);
  const calories = sum('calories');
  const weight = (c: ResolvedComponent) => (calories > 0 ? c.calories : 1);
  const totalWeight = components.reduce((s, c) => s + weight(c), 0);
  const healthScore = totalWeight > 0 ? Math.round(components.reduce((s, c) => s + c.healthScore * weight(c), 0) / totalWeight) : 0;
  const names = (pick: (c: ResolvedComponent) => string | null) => {
    const parts = components.map(pick);
    return parts.every((p) => p) ? parts.join(', ') : null;
  };
  return {
    calories: Math.min(Math.round(calories), maxCalories),
    proteinG: Math.min(round1(sum('proteinG')), MAX_MACRO_G),
    carbsG: Math.min(round1(sum('carbsG')), MAX_MACRO_G),
    fatG: Math.min(round1(sum('fatG')), MAX_MACRO_G),
    healthScore,
    name: names((c) => c.dish.nameEn) ?? 'Meal',
    nameKm: names((c) => c.dish.nameKm),
  };
}
