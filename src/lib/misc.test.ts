import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env';
import { goalAt } from '../modules/goals/goals.service';
import { aiMealSchema, snapPortion } from './analyzer/schema';
import { loadCatalog, normalizeDishName } from './catalog';
import { sniffImageKind } from './image';
import { mealTotals, subtractNutrition, sumNutrition } from './nutrition';
import { parseOffProduct } from './product-lookup';

describe('sniffImageKind (magic bytes)', () => {
  const pad = (b: number[]) => Buffer.concat([Buffer.from(b), Buffer.alloc(32)]);
  it('recognises JPEG, PNG, WebP and HEIC', () => {
    expect(sniffImageKind(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageKind(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffImageKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]))).toBe('webp');
    expect(sniffImageKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(16)]))).toBe('heic');
    expect(sniffImageKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmif1'), Buffer.alloc(16)]))).toBe('heic');
  });
  it('rejects everything else, including MP4 and scripts renamed to .jpg', () => {
    expect(sniffImageKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(16)]))).toBeNull();
    expect(sniffImageKind(Buffer.from('<script>alert(1)</script> and more bytes'))).toBeNull();
    expect(sniffImageKind(Buffer.from('GIF89a......................'))).toBeNull();
    expect(sniffImageKind(Buffer.alloc(3))).toBeNull();
  });
});

describe('AI result validation (meal-analysis.v2)', () => {
  const dish = {
    match: 'kuy-teav',
    nameEn: 'Pork Noodle Soup (Kuy Teav)',
    nameKm: 'គុយទាវ',
    portion: '1.5',
    standardServing: { description: '1 bowl', calories: 420, proteinG: 22, carbsG: 58, fatG: 11, healthScore: 6 },
  };
  const valid = { isFood: true, confidence: 0.82, dishes: [dish] };
  it('accepts the contract', () => {
    expect(aiMealSchema.safeParse(valid).success).toBe(true);
    expect(aiMealSchema.safeParse({ isFood: false, confidence: 0, dishes: [] }).success).toBe(true);
  });
  it.each([
    ['negative calories', { ...valid, dishes: [{ ...dish, standardServing: { ...dish.standardServing, calories: -1 } }] }],
    ['health score above 10', { ...valid, dishes: [{ ...dish, standardServing: { ...dish.standardServing, healthScore: 11 } }] }],
    ['confidence above 1', { ...valid, confidence: 1.5 }],
    ['missing isFood', { ...valid, isFood: undefined }],
    ['an unknown portion word', { ...valid, dishes: [{ ...dish, portion: 'big' }] }],
    ['more than 6 dishes', { ...valid, dishes: Array.from({ length: 7 }, () => dish) }],
    ['not an object', 'I think this is a sandwich'],
  ])('rejects %s', (_label, value) => {
    expect(aiMealSchema.safeParse(value).success).toBe(false);
  });
  it('snaps any portion to the nearest allowed step', () => {
    expect([snapPortion('1.5'), snapPortion(1.4), snapPortion(0.1), snapPortion(9), snapPortion('x')]).toEqual([1.5, 1.5, 0.25, 3, 1]);
  });
});

describe('normalizeDishName', () => {
  it('reduces a dish name to lowercase ASCII words', () => {
    expect(normalizeDishName('Pork & Rice (Bai Sach Chrouk)')).toBe('pork rice bai sach chrouk');
    expect(normalizeDishName('Turkey Sandwich With Potato Chips')).toBe('turkey sandwich potato chips');
    expect(normalizeDishName("  Bok L'hong ")).toBe('bok l hong');
  });
});

describe('the Khmer food catalog file', () => {
  const dishes = loadCatalog();
  it('has 50 unique dishes whose macros add up to their calories', () => {
    expect(dishes).toHaveLength(50);
    for (const d of dishes) {
      const fromMacros = 4 * d.proteinG + 4 * d.carbsG + 9 * d.fatG;
      expect(Math.abs(fromMacros - d.calories) / d.calories, d.slug).toBeLessThanOrEqual(0.12);
      expect(d.sources.length, d.slug).toBeGreaterThan(0);
    }
  });
});

describe('Open Food Facts parsing', () => {
  it('uses per-serving values when present', () => {
    const p = parseOffProduct('123', {
      product_name: 'Granola', brands: 'Acme, Other', serving_size: '45 g', nutriscore_grade: 'b',
      nutriments: { 'energy-kcal_serving': 200, proteins_serving: 4.5, carbohydrates_serving: 30, fat_serving: 7 },
    });
    expect(p).toMatchObject({ name: 'Granola', brand: 'Acme', servingSize: '45 g', calories: 200, proteinG: 4.5, carbsG: 30, fatG: 7, healthScore: 8 });
  });
  it('scales per-100g values by the serving quantity', () => {
    const p = parseOffProduct('123', {
      product_name: 'Crackers', serving_quantity: 30,
      nutriments: { 'energy-kcal_100g': 400, proteins_100g: 10, carbohydrates_100g: 70, fat_100g: 10 },
    });
    expect(p).toMatchObject({ calories: 120, proteinG: 3, carbsG: 21, fatG: 3, servingSize: '30 g', healthScore: null });
  });
  it('falls back to 100 g, and converts kJ when kcal is missing', () => {
    const p = parseOffProduct('123', { product_name: 'Juice', nutriments: { energy_100g: 209.2, carbohydrates_100g: 11 } });
    expect(p).toMatchObject({ calories: 50, carbsG: 11, proteinG: 0, servingSize: '100 g' });
  });
  it('returns null when calories are unknown', () => {
    expect(parseOffProduct('123', { product_name: 'Mystery', nutriments: {} })).toBeNull();
  });
});

describe('nutrition maths', () => {
  const base = { calories: 460, proteinG: 25, carbsG: 45, fatG: 20, analyzedAt: new Date() };
  it('totals are per-serving x quantity, rounded', () => {
    expect(mealTotals({ ...base, quantity: 1.5 })).toEqual({ calories: 690, proteinG: 37.5, carbsG: 67.5, fatG: 30 });
    expect(mealTotals({ ...base, calories: 333, quantity: 0.25 })?.calories).toBe(83);
  });
  it('meals without values (still analyzing) have no totals and are skipped by sums', () => {
    expect(mealTotals({ ...base, analyzedAt: null, quantity: 1 })).toBeNull();
    expect(mealTotals({ ...base, calories: null, quantity: 1 })).toBeNull();
    expect(sumNutrition([mealTotals({ ...base, quantity: 1 }), null])).toEqual({ calories: 460, proteinG: 25, carbsG: 45, fatG: 20 });
  });
  it('reproduces the mock-up: 2199 - 460 = 1739, 161 - 25 = 136, 251 - 45 = 206, 61 - 20 = 41', () => {
    const remaining = subtractNutrition({ calories: 2199, proteinG: 161, carbsG: 251, fatG: 61 }, { calories: 460, proteinG: 25, carbsG: 45, fatG: 20 });
    expect(remaining).toEqual({ calories: 1739, proteinG: 136, carbsG: 206, fatG: 41 });
  });
  it('remaining can go negative', () => {
    expect(subtractNutrition({ calories: 100, proteinG: 1, carbsG: 1, fatG: 1 }, { calories: 250, proteinG: 0.5, carbsG: 3, fatG: 1 }).calories).toBe(-150);
  });
  it('float sums do not drift (0.1 + 0.2)', () => {
    const t = { calories: 1, proteinG: 0.1, carbsG: 0.2, fatG: 0 };
    expect(sumNutrition([t, { ...t, proteinG: 0.2, carbsG: 0.1 }]).proteinG).toBe(0.3);
  });
});

describe('goalAt', () => {
  const g = (iso: string, id: string) => ({ id, effectiveFrom: new Date(iso) });
  const goals = [g('2026-01-01T00:00:00Z', 'a'), g('2026-02-01T00:00:00Z', 'b'), g('2026-03-01T00:00:00Z', 'c')];
  it('picks the latest goal that started on or before the instant', () => {
    expect(goalAt(goals, new Date('2026-02-15T00:00:00Z'))?.id).toBe('b');
    expect(goalAt(goals, new Date('2026-03-01T00:00:00Z'))?.id).toBe('c');
    expect(goalAt(goals, new Date('2030-01-01T00:00:00Z'))?.id).toBe('c');
  });
  it('falls back to the earliest goal for dates before the first one', () => {
    expect(goalAt(goals, new Date('2020-01-01T00:00:00Z'))?.id).toBe('a');
  });
  it('is undefined with no goals', () => {
    expect(goalAt([], new Date())).toBeUndefined();
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'a'.repeat(40) };
  it('parses defaults and keeps the app name configurable', () => {
    const c = loadConfig({ ...base, APP_NAME: 'Cal AI' });
    expect(c.appName).toBe('Cal AI');
    expect(c.ai.model).toBe('claude-opus-5-5');
    expect(c.rateLimit).toMatchObject({ authPerMin: 10, planPreviewPerMin: 30, analyzePerHour: 20, generalPerMin: 300 });
    expect(c.plan.loseCalorieFloor).toEqual({ male: 1500, female: 1200, other: 1200 });
  });
  it('takes tunables from the environment', () => {
    const c = loadConfig({ ...base, PLAN_CALORIE_FLOOR_FEMALE: '1300', PLAN_ADJUST_LOSE: '-0.2', AI_PROVIDER: 'openai', RATE_LIMIT_AUTH_PER_MIN: '5' });
    expect(c.plan.loseCalorieFloor.female).toBe(1300);
    expect(c.plan.goalAdjustment.lose).toBe(-0.2);
    expect(c.ai.model).toBe('gpt-4o');
    expect(c.rateLimit.authPerMin).toBe(5);
  });
  it('treats empty values as unset and fails fast on bad ones', () => {
    expect(loadConfig({ ...base, PORT: '' }).port).toBe(3000);
    expect(() => loadConfig({ DATABASE_URL: 'x', JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'gemini' })).toThrow(/AI_PROVIDER/);
  });
  it('refuses development-only drivers in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AI_PROVIDER: 'fake', QUEUE_DRIVER: 'memory', STORAGE_DRIVER: 'memory' })).toThrow(
      /QUEUE_DRIVER=memory[\s\S]*STORAGE_DRIVER=memory[\s\S]*AI_PROVIDER=fake/,
    );
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k', REDIS_URL: 'redis://r' }).isProd).toBe(true);
  });
});
