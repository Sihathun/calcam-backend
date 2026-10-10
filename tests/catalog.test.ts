import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDishResolver } from '../src/modules/meals/dish-resolver';
import { analyzeMeal, createTestContext, jpeg, registerUser, type TestContext, type TestUser } from './helpers';

// Catalog grounded analysis (spec 0001.3): the model names dishes and portion steps, the server owns the numbers.

let ctx: TestContext;
beforeAll(() => {
  ctx = createTestContext();
});
const api = '/api/v1';

const dish = (slug: string) => ctx.deps.prisma.foodDish.findUniqueOrThrow({ where: { slug } });
const round1 = (n: number) => Math.round(n * 10) / 10;

describe('catalog grounded analysis', () => {
  it('lists the catalog in the prompt and computes nutrition as reference x portion', async () => {
    const u = await registerUser(ctx);
    const ref = await dish('kuy-teav');
    const meal = await analyzeMeal(ctx, u, { hint: 'catalog:kuy-teav@1.5' });

    const listed = ctx.analyzer.calls.at(-1)!.dishes.map((d) => d.slug);
    expect(listed).toContain('kuy-teav');
    expect(listed.length).toBeGreaterThanOrEqual(50);

    expect(meal).toMatchObject({
      status: 'completed',
      name: ref.nameEn,
      nameKm: ref.nameKm,
      healthScore: ref.healthScore,
      perServing: {
        calories: Math.round(ref.calories * 1.5),
        proteinG: round1(ref.proteinG * 1.5),
        carbsG: round1(ref.carbsG * 1.5),
        fatG: round1(ref.fatG * 1.5),
      },
    });
    expect(meal.components).toEqual([
      expect.objectContaining({ dishSlug: 'kuy-teav', nameKm: ref.nameKm, portion: 1.5, valueSource: 'catalog' }),
    ]);
    expect(meal.items).toHaveLength(1);
  });

  it('gives identical numbers for the same dish and portion', async () => {
    const u = await registerUser(ctx);
    const a = await analyzeMeal(ctx, u, { hint: 'catalog:fish-amok@1' });
    const b = await analyzeMeal(ctx, u, { hint: 'catalog:fish-amok@1' });
    expect(b.perServing).toEqual(a.perServing);
    expect(b.healthScore).toBe(a.healthScore);
  });

  it('sums several dishes, joins their names and weights the health score by calories', async () => {
    const u = await registerUser(ctx);
    const [rice, soup, coconut] = await Promise.all([dish('bai-sror'), dish('samlor-machu-trey'), dish('tuk-dong')]);
    const meal = await analyzeMeal(ctx, u, { hint: 'catalog:bai-sror@1,samlor-machu-trey@1,tuk-dong@1' });
    const parts = [rice, soup, coconut];
    const calories = parts.reduce((s, d) => s + d.calories, 0);
    expect(meal.perServing.calories).toBe(calories);
    expect(meal.healthScore).toBe(Math.round(parts.reduce((s, d) => s + d.healthScore * d.calories, 0) / calories));
    expect(meal.name).toBe(parts.map((d) => d.nameEn).join(', '));
    expect(meal.nameKm).toBe(parts.map((d) => d.nameKm).join(', '));
    expect(meal.components.map((c: any) => c.dishSlug)).toEqual(['bai-sror', 'samlor-machu-trey', 'tuk-dong']);
  });

  it("uses the user's own correction for that dish next time, and only for that user", async () => {
    const u = await registerUser(ctx);
    const other = await registerUser(ctx);
    const first = await analyzeMeal(ctx, u, { hint: 'catalog:bai-cha@1' });

    const edited = await ctx.http
      .patch(`${api}/meals/${first.id}`)
      .set(u.auth)
      .send({ calories: 450, proteinG: 18, carbsG: 60, fatG: 15 });
    expect(edited.status).toBe(200);
    const stored = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.userEditedAt).not.toBeNull();
    expect(stored.originalNutrition).toMatchObject({ calories: first.perServing.calories });

    // A second edit keeps the values from before the FIRST edit.
    await ctx.http.patch(`${api}/meals/${first.id}`).set(u.auth).send({ calories: 440 });
    const again = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id: first.id } });
    expect(again.originalNutrition).toMatchObject({ calories: first.perServing.calories });

    // Half a portion of the corrected dish: the user's values, halved.
    const mine = await analyzeMeal(ctx, u, { hint: 'catalog:bai-cha@0.5' });
    expect(mine.perServing).toMatchObject({ calories: 220, proteinG: 9, carbsG: 30, fatG: 7.5 });
    expect(mine.components[0].valueSource).toBe('personal');

    const theirs = await analyzeMeal(ctx, other, { hint: 'catalog:bai-cha@1' });
    expect(theirs.perServing.calories).toBe((await dish('bai-cha')).calories);
    expect(theirs.components[0].valueSource).toBe('catalog');
  });

  it('remembers a corrected portion as values per standard serving', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u, { hint: 'catalog:mi-cha@2' });
    await ctx.http.patch(`${api}/meals/${meal.id}`).set(u.auth).send({ calories: 1000 });
    const ref = await dish('mi-cha');
    const override = await ctx.deps.prisma.userDishOverride.findUniqueOrThrow({
      where: { userId_dishId: { userId: u.id, dishId: ref.id } },
    });
    expect(override.calories).toBe(500);
  });

  it('does not learn from meals of several dishes, or from a quantity change', async () => {
    const u = await registerUser(ctx);
    const multi = await analyzeMeal(ctx, u, { hint: 'catalog:bai-sror@1,trey-ang@1' });
    await ctx.http.patch(`${api}/meals/${multi.id}`).set(u.auth).send({ calories: 300 });
    const single = await analyzeMeal(ctx, u, { hint: 'catalog:bobor-trey@1' });
    await ctx.http.patch(`${api}/meals/${single.id}`).set(u.auth).send({ quantity: 2 });
    expect(await ctx.deps.prisma.userDishOverride.count({ where: { userId: u.id } })).toBe(0);
    const stored = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id: single.id } });
    expect(stored.userEditedAt).toBeNull();
  });

  it('a renamed meal drops its Khmer name', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u, { hint: 'catalog:nom-krok@1' });
    expect(meal.nameKm).not.toBeNull();
    const renamed = await ctx.http.patch(`${api}/meals/${meal.id}`).set(u.auth).send({ name: "Grandma's nom krok" });
    expect(renamed.body.meal).toMatchObject({ name: "Grandma's nom krok", nameKm: null });
  });
});

describe('learned dishes', () => {
  it('saves a dish the catalog lacks, so the next scan of it gets the same values', async () => {
    const u = await registerUser(ctx);
    const first = await analyzeMeal(ctx, u, { hint: 'extra mayo' }); // the fake answers with two new dishes
    const sandwich = await ctx.deps.prisma.foodDish.findUniqueOrThrow({ where: { normalizedName: 'turkey sandwich' } });
    expect(sandwich).toMatchObject({ kind: 'learned', nameEn: 'Turkey Sandwich', calories: 340 });
    expect(first.components.map((c: any) => c.valueSource)).toEqual(['learned', 'learned']);
    expect(first.perServing.calories).toBe(460);

    const next = await analyzeMeal(ctx, u, { hint: 'more mayo' });
    expect(next.perServing).toEqual(first.perServing);
  });

  it('two scans naming the same new dish at once create one dish', async () => {
    const resolver = createDishResolver(ctx.deps.prisma, { maxCalories: 5000, now: () => new Date() });
    const u = await registerUser(ctx);
    const name = `Mystery Stew ${randomUUID().slice(0, 8)}`;
    const ai = {
      match: 'new',
      nameEn: name,
      nameKm: '',
      portion: '1' as const,
      standardServing: { description: '1 bowl', calories: 400, proteinG: 20, carbsG: 30, fatG: 15, healthScore: 6 },
    };
    const [a, b] = await Promise.all([
      resolver.resolve(u.id, randomUUID(), [ai]),
      resolver.resolve(u.id, randomUUID(), [{ ...ai, standardServing: { ...ai.standardServing, calories: 999 } }]),
    ]);
    expect(a[0]!.dish.id).toBe(b[0]!.dish.id);
    expect(a[0]!.calories).toBe(b[0]!.calories);
    expect(await ctx.deps.prisma.foodDish.count({ where: { nameEn: name } })).toBe(1);
  });

  it('maps a "new" answer onto a catalog dish by its name or alias', async () => {
    const resolver = createDishResolver(ctx.deps.prisma, { maxCalories: 5000, now: () => new Date() });
    const u = await registerUser(ctx);
    const serving = { description: '1 plate', calories: 1, proteinG: 1, carbsG: 1, fatG: 1, healthScore: 1 };
    const [byAlias] = await resolver.resolve(u.id, randomUUID(), [
      { match: 'new', nameEn: 'Bai Sach Chrouk', nameKm: '', portion: '1', standardServing: serving },
    ]);
    expect(byAlias!.dish.slug).toBe('bai-sach-chrouk');
    expect(byAlias!.valueSource).toBe('catalog');
  });

  it('clamps an implausible serving', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u, { hint: 'huge' });
    expect(meal.perServing.calories).toBe(5000);
  });
});

describe('the same photo again', () => {
  it("reuses the earlier dishes and portions for the same user, without asking the model", async () => {
    const u = await registerUser(ctx);
    const other = await registerUser(ctx);
    const photo = await jpeg(640, 480);
    ctx.analyzer.calls = [];
    const first = await analyzeMeal(ctx, u, { image: photo });
    const second = await analyzeMeal(ctx, u, { image: photo });
    expect(ctx.analyzer.calls).toHaveLength(1);
    expect(second.perServing).toEqual(first.perServing);
    expect(second.components.map((c: any) => c.dishSlug)).toEqual(first.components.map((c: any) => c.dishSlug));
    const stored = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id: second.id } });
    expect(stored.aiRaw).toMatchObject({ reusedFromHash: stored.imageSha256 });

    await analyzeMeal(ctx, other, { image: photo });
    expect(ctx.analyzer.calls).toHaveLength(2); // another user's photo is analyzed on its own
  });
});

describe('account deletion', () => {
  it("removes the user's components and corrections but keeps the shared dishes", async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u, { hint: 'catalog:lort-cha@1' });
    await ctx.http.patch(`${api}/meals/${meal.id}`).set(u.auth).send({ calories: 500 });
    expect(await ctx.deps.prisma.userDishOverride.count({ where: { userId: u.id } })).toBe(1);

    await ctx.http.delete(`${api}/me`).set(u.auth);
    await ctx.queue.drain();
    expect(await ctx.deps.prisma.mealComponent.count({ where: { mealId: meal.id } })).toBe(0);
    expect(await ctx.deps.prisma.userDishOverride.count({ where: { userId: u.id } })).toBe(0);
    expect(await ctx.deps.prisma.foodDish.count({ where: { slug: 'lort-cha' } })).toBe(1);
  });
});
