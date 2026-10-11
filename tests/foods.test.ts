import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildUserText } from '../src/lib/analyzer/prompts/meal-analysis.v3';
import { analyzeMeal, createTestContext, registerUser, type TestContext, type TestUser } from './helpers';

// Food picker (spec 0002): the user logs a meal by choosing a catalog food, with no photo and no AI.

let ctx: TestContext;
/** Every real catalog food has a photo, so one without a photo file is added for the tests that need it. */
const NO_PHOTO = 'zz-test-food-without-photo';
beforeAll(async () => {
  ctx = createTestContext();
  await ctx.deps.prisma.foodDish.upsert({
    where: { slug: NO_PHOTO },
    update: {},
    create: {
      slug: NO_PHOTO,
      kind: 'catalog',
      nameEn: 'Zz Test Food Without Photo',
      normalizedName: 'zz test food without photo',
      servingDescription: '1 test serving',
      calories: 100,
      proteinG: 5,
      carbsG: 10,
      fatG: 3,
      healthScore: 5,
    },
  });
});
afterAll(async () => {
  await ctx.deps.prisma.mealComponent.deleteMany({ where: { dish: { slug: NO_PHOTO } } });
  await ctx.deps.prisma.foodDish.deleteMany({ where: { slug: NO_PHOTO } });
});
const api = '/api/v1';

const dish = (slug: string) => ctx.deps.prisma.foodDish.findUniqueOrThrow({ where: { slug } });
const fromFood = (u: TestUser, body: Record<string, unknown>) => ctx.http.post(`${api}/meals/from-food`).set(u.auth).send(body);
const listFoods = (u: TestUser) => ctx.http.get(`${api}/foods`).set(u.auth);

describe('GET /foods', () => {
  it('needs a signed-in user', async () => {
    expect((await ctx.http.get(`${api}/foods`)).status).toBe(401);
  });

  it('lists every catalog food with its nutrition and never a learned dish', async () => {
    const u = await registerUser(ctx);
    await analyzeMeal(ctx, u, { hint: 'extra mayo' }); // the fake answers with two new (learned) dishes
    expect(await ctx.deps.prisma.foodDish.count({ where: { kind: 'learned' } })).toBeGreaterThan(0);

    const res = await listFoods(u);
    expect(res.status).toBe(200);
    const slugs = res.body.items.map((f: any) => f.slug);
    expect(res.body.items).toHaveLength(await ctx.deps.prisma.foodDish.count({ where: { kind: 'catalog' } }));
    expect(res.body.items.length).toBeGreaterThanOrEqual(65);
    expect(slugs).not.toContain('learned-turkey-sandwich');
    expect(slugs).toEqual(expect.arrayContaining(['bai-cha', 'kuy-teav-sach-ko', 'green-papaya', 'roasted-peanuts']));

    const ref = await dish('bai-cha');
    expect(res.body.items.find((f: any) => f.slug === 'bai-cha')).toMatchObject({
      nameEn: ref.nameEn,
      nameKm: ref.nameKm,
      category: 'rice_dish',
      servingDescription: ref.servingDescription,
      calories: ref.calories,
      proteinG: ref.proteinG,
      carbsG: ref.carbsG,
      fatG: ref.fatG,
      healthScore: ref.healthScore,
      personal: false,
    });
    expect(res.body.items.find((f: any) => f.slug === 'green-papaya').category).toBe('ingredient');
    expect(res.body.recent).toEqual([]);
  });

  it('gives a photo URL only to foods that have a photo file', async () => {
    const u = await registerUser(ctx);
    const items = (await listFoods(u)).body.items as { slug: string; photoUrl: string | null }[];
    expect(items.find((f) => f.slug === 'bai-cha')!.photoUrl).toBe(`${ctx.config.publicBaseUrl}/food-photos/bai-cha.webp`);
    expect(items.find((f) => f.slug === NO_PHOTO)!.photoUrl).toBeNull();
    // The catalog files themselves: every real food has a photo.
    expect(items.filter((f) => f.slug !== NO_PHOTO && !f.photoUrl).map((f) => f.slug)).toEqual([]);
  });

  it("shows the user's own corrected values, only to them", async () => {
    const u = await registerUser(ctx);
    const other = await registerUser(ctx);
    const meal = (await fromFood(u, { dishSlug: 'bai-cha' })).body.meal;
    await ctx.http.patch(`${api}/meals/${meal.id}`).set(u.auth).send({ calories: 450, proteinG: 18, carbsG: 60, fatG: 15 });

    const mine = (await listFoods(u)).body.items.find((f: any) => f.slug === 'bai-cha');
    expect(mine).toMatchObject({ calories: 450, proteinG: 18, carbsG: 60, fatG: 15, personal: true });
    const theirs = (await listFoods(other)).body.items.find((f: any) => f.slug === 'bai-cha');
    expect(theirs).toMatchObject({ calories: (await dish('bai-cha')).calories, personal: false });
  });

  it('lists recent foods newest first without repeats, counting scans too', async () => {
    const u = await registerUser(ctx);
    const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    await fromFood(u, { dishSlug: 'bai-cha', loggedAt: at(5) });
    await fromFood(u, { dishSlug: 'mi-cha', loggedAt: at(4) });
    await fromFood(u, { dishSlug: 'bai-cha', loggedAt: at(3) });
    await analyzeMeal(ctx, u, { hint: 'catalog:fish-amok@1', loggedAt: at(1) });
    const gone = (await fromFood(u, { dishSlug: 'lort-cha', loggedAt: at(0.5) })).body.meal;
    await ctx.http.delete(`${api}/meals/${gone.id}`).set(u.auth);

    expect((await listFoods(u)).body.recent).toEqual(['fish-amok', 'bai-cha', 'mi-cha']);
    expect((await listFoods(await registerUser(ctx))).body.recent).toEqual([]);
  });
});

describe('POST /meals/from-food', () => {
  it("logs a completed meal with the food's values and one component", async () => {
    const u = await registerUser(ctx);
    const ref = await dish('kuy-teav-sach-ko');
    const res = await fromFood(u, { dishSlug: 'kuy-teav-sach-ko' });
    expect(res.status).toBe(201);
    expect(res.body.meal).toMatchObject({
      source: 'catalog',
      status: 'completed',
      progress: 100,
      name: ref.nameEn,
      nameKm: ref.nameKm,
      quantity: 1,
      healthScore: ref.healthScore,
      perServing: { calories: ref.calories, proteinG: ref.proteinG, carbsG: ref.carbsG, fatG: ref.fatG },
      totals: { calories: ref.calories, proteinG: ref.proteinG },
    });
    expect(res.body.meal.components).toEqual([
      expect.objectContaining({ dishSlug: 'kuy-teav-sach-ko', portion: 1, calories: ref.calories, valueSource: 'catalog' }),
    ]);
    expect(res.body.meal.items).toHaveLength(1);

    const got = await ctx.http.get(`${api}/meals/${res.body.meal.id}`).set(u.auth);
    expect(got.body.meal.components).toHaveLength(1);
  });

  it('uses the dish photo as the meal picture when there is one', async () => {
    const u = await registerUser(ctx);
    const withPhoto = (await fromFood(u, { dishSlug: 'bai-cha' })).body.meal;
    expect(withPhoto.imageUrl).toBe(`${ctx.config.publicBaseUrl}/food-photos/bai-cha.webp`);
    expect(withPhoto.thumbnailUrl).toBe(withPhoto.imageUrl);
    const without = (await fromFood(u, { dishSlug: NO_PHOTO })).body.meal;
    expect(without.imageUrl).toBeNull();
  });

  it('scales with quantity and counts in the day at once', async () => {
    const u = await registerUser(ctx);
    const ref = await dish('bai-sror');
    const res = await fromFood(u, { dishSlug: 'bai-sror', quantity: 1.5 });
    expect(res.body.meal.totals.calories).toBe(Math.round(ref.calories * 1.5));

    const day = await ctx.http.get(`${api}/dashboard/daily`).set(u.auth).query({ date: 'today' });
    expect(day.body.consumed.calories).toBe(Math.round(ref.calories * 1.5));
    expect(day.body.meals[0]).toMatchObject({
      source: 'catalog',
      thumbnailUrl: `${ctx.config.publicBaseUrl}/food-photos/bai-sror.webp`,
    });
  });

  it("uses the user's own values once they corrected the food, and an edit teaches the dish", async () => {
    const u = await registerUser(ctx);
    const first = (await fromFood(u, { dishSlug: 'mi-cha' })).body.meal;
    const edited = await ctx.http.patch(`${api}/meals/${first.id}`).set(u.auth).send({ calories: 400, proteinG: 20, carbsG: 50, fatG: 12 });
    expect(edited.status).toBe(200);
    const stored = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.userEditedAt).not.toBeNull();

    const next = (await fromFood(u, { dishSlug: 'mi-cha' })).body.meal;
    expect(next.perServing).toMatchObject({ calories: 400, proteinG: 20, carbsG: 50, fatG: 12 });
    expect(next.components[0].valueSource).toBe('personal');
  });

  it('answers 404 FOOD_NOT_FOUND for an unknown food and for a learned dish', async () => {
    const u = await registerUser(ctx);
    const unknown = await fromFood(u, { dishSlug: 'no-such-food' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('FOOD_NOT_FOUND');

    await analyzeMeal(ctx, u, { hint: 'extra mayo' });
    const learned = await ctx.deps.prisma.foodDish.findFirstOrThrow({ where: { kind: 'learned' } });
    expect((await fromFood(u, { dishSlug: learned.slug })).body.error.code).toBe('FOOD_NOT_FOUND');
  });

  it('validates the body and needs a signed-in user', async () => {
    const u = await registerUser(ctx);
    expect((await fromFood(u, {})).status).toBe(400);
    expect((await fromFood(u, { dishSlug: 'bai-cha', quantity: 99 })).status).toBe(400);
    expect((await ctx.http.post(`${api}/meals/from-food`).send({ dishSlug: 'bai-cha' })).status).toBe(401);
  });

  it('cannot be re-analyzed with Fix Results', async () => {
    const u = await registerUser(ctx);
    const meal = (await fromFood(u, { dishSlug: 'bai-cha' })).body.meal;
    const fix = await ctx.http.post(`${api}/meals/${meal.id}/fix`).set(u.auth).send({ instruction: 'it was bigger' });
    expect(fix.status).toBe(422);
    expect(fix.body.error.code).toBe('FIX_NOT_SUPPORTED');
  });

  it("is invisible to other users and goes away with the user's meal delete", async () => {
    const u = await registerUser(ctx);
    const other = await registerUser(ctx);
    const meal = (await fromFood(u, { dishSlug: 'bai-cha' })).body.meal;
    expect((await ctx.http.get(`${api}/meals/${meal.id}`).set(other.auth)).status).toBe(404);
    expect((await ctx.http.delete(`${api}/meals/${meal.id}`).set(u.auth)).status).toBe(204);
    expect((await ctx.http.get(`${api}/meals/${meal.id}`).set(u.auth)).status).toBe(404);
  });
});

describe('food photos', () => {
  it('serves a photo as a cacheable WebP that other origins may show', async () => {
    const res = await ctx.http.get('/food-photos/bai-cha.webp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['cache-control']).toContain('max-age=');
  });

  it('serves the photo of every catalog food, each a real WebP', async () => {
    const u = await registerUser(ctx);
    const items = (await listFoods(u)).body.items as { slug: string; photoUrl: string | null }[];
    for (const f of items.filter((x) => x.photoUrl)) {
      const res = await ctx.http.get(new URL(f.photoUrl!).pathname).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status, f.slug).toBe(200);
      const bytes = res.body as Buffer;
      expect(bytes.subarray(0, 4).toString('latin1'), f.slug).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('latin1'), f.slug).toBe('WEBP');
    }
  });

  it('answers 404 for a missing photo and never lists the folder', async () => {
    expect((await ctx.http.get('/food-photos/not-a-food.webp')).status).toBe(404);
    expect((await ctx.http.get('/food-photos/')).status).toBe(404);
    expect((await ctx.http.get('/food-photos/sources.json')).status).toBe(404);
  });
});

describe('single foods in the analysis prompt', () => {
  it('marks ingredients so the model prefers the whole dish', async () => {
    const u = await registerUser(ctx);
    await analyzeMeal(ctx, u, { hint: 'catalog:bai-cha@1' });
    const listed = ctx.analyzer.calls.at(-1)!.dishes;
    expect(listed.find((d) => d.slug === 'green-papaya')?.ingredient).toBe(true);
    expect(listed.find((d) => d.slug === 'bai-cha')?.ingredient).toBe(false);

    const text = buildUserText({ dishes: listed, corrections: [], locale: 'en' });
    expect(text).toMatch(/green-papaya \|.*\| single food/);
    expect(text).not.toMatch(/bai-cha \|.*\| single food/);
  });
});
