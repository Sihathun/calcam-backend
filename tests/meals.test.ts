import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/lib/analyzer/types';
import { TransientError } from '../src/lib/errors';
import {
  analyzeMeal,
  createTestContext,
  jpeg,
  registerUser,
  uploadMeal,
  type TestContext,
  type TestUser,
} from './helpers';

let ctx: TestContext;
let user: TestUser;
beforeAll(async () => {
  ctx = createTestContext();
  user = await registerUser(ctx);
});
const api = '/api/v1';

const getMeal = async (u: TestUser, id: string) => (await ctx.http.get(`${api}/meals/${id}`).set(u.auth)).body.meal;

describe('POST /meals/analyze', () => {
  it('returns 202 at once with a queued meal, and the worker completes it', async () => {
    const u = await registerUser(ctx);
    ctx.queue.paused = true;
    const res = await uploadMeal(ctx, u, { source: 'camera' });
    ctx.queue.paused = false;
    expect(res.status).toBe(202);
    expect(res.body.meal).toMatchObject({ status: 'queued', progress: 5, name: null, source: 'photo', reanalyzing: false });
    expect(res.body.meal.totals).toEqual({ calories: null, proteinG: null, carbsG: null, fatG: null });
    expect(res.body.meal.thumbnailUrl).toMatch(/^memory:\/\/users\//);
    // The API never calls the AI provider: only the worker does.
    expect(ctx.analyzer.calls.length).toBe(0);

    await ctx.queue.enqueueMealAnalysis(res.body.meal.id);
    await ctx.queue.drain();
    const meal = await getMeal(u, res.body.meal.id);
    expect(meal).toMatchObject({
      name: 'Turkey Sandwich, Potato Chips',
      status: 'completed',
      progress: 100,
      healthScore: 7,
      quantity: 1,
      perServing: { calories: 460, proteinG: 25, carbsG: 45, fatG: 20 },
      totals: { calories: 460, proteinG: 25, carbsG: 45, fatG: 20 },
      errorCode: null,
    });
    expect(meal.items).toHaveLength(2);
    expect(meal.imageUrl).toMatch(/^memory:\/\//);
  });

  it('reports stage-based progress while the model is working, and keeps the raw answer', async () => {
    const u = await registerUser(ctx);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = ctx.analyzer.analyze.bind(ctx.analyzer);
    ctx.analyzer.analyze = async (input) => {
      await gate;
      return original(input);
    };
    try {
      const res = await uploadMeal(ctx, u);
      await new Promise((r) => setTimeout(r, 300));
      const mid = await getMeal(u, res.body.meal.id);
      expect(mid).toMatchObject({ status: 'analyzing', progress: 20 });
      release();
      await ctx.queue.drain();
    } finally {
      ctx.analyzer.analyze = original;
    }
    const meal = await ctx.deps.prisma.meal.findFirstOrThrow({ where: { userId: u.id } });
    expect(meal.aiRaw).toMatchObject({ promptVersion: 'meal-analysis.v2', provider: 'fake' });
  });

  it('sends a push notification with the meal id when analysis completes', async () => {
    const u = await registerUser(ctx);
    const token = `push-${Date.now()}-${'a'.repeat(30)}`;
    await ctx.http.post(`${api}/me/devices`).set(u.auth).send({ token, platform: 'android' });
    const meal = await analyzeMeal(ctx, u);
    const sent = ctx.push.sent.find((s) => s.tokens.includes(token))!;
    expect(sent.message.title).toBe('Your meal is ready');
    expect(sent.message.data).toEqual({ mealId: meal['id'], status: 'completed' });
  });

  it('does not push when notifications are off, and drops tokens the provider rejects', async () => {
    const u = await registerUser(ctx);
    const token = `quiet-${Date.now()}-${'b'.repeat(30)}`;
    await ctx.http.post(`${api}/me/devices`).set(u.auth).send({ token, platform: 'ios' });
    await ctx.http.patch(`${api}/me/preferences`).set(u.auth).send({ notificationsEnabled: false });
    await analyzeMeal(ctx, u);
    expect(ctx.push.sent.some((s) => s.tokens.includes(token))).toBe(false);

    await ctx.http.patch(`${api}/me/preferences`).set(u.auth).send({ notificationsEnabled: true });
    const original = ctx.push.send.bind(ctx.push);
    ctx.push.send = async (tokens, message) => {
      await original(tokens, message);
      return { invalidTokens: [token] };
    };
    try {
      await analyzeMeal(ctx, u);
    } finally {
      ctx.push.send = original;
    }
    expect(await ctx.deps.prisma.deviceToken.count({ where: { token } })).toBe(0);
  });

  it('accepts gallery photos with the same endpoint, in PNG and WebP too', async () => {
    const u = await registerUser(ctx);
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
    const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).webp().toBuffer();
    for (const image of [png, webp]) {
      const res = await uploadMeal(ctx, u, { source: 'gallery', image });
      expect(res.status).toBe(202);
    }
    await ctx.queue.drain();
    const rows = await ctx.deps.prisma.meal.findMany({ where: { userId: u.id } });
    expect(rows.every((m) => m.captureMethod === 'gallery' && m.status === 'completed')).toBe(true);
  });

  it('trusts magic bytes, not the Content-Type header or file name', async () => {
    const u = await registerUser(ctx);
    const res = await ctx.http
      .post(`${api}/meals/analyze`)
      .set(u.auth)
      .attach('image', Buffer.from('<?php echo "not an image"; ?> padding padding'), { filename: 'meal.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await ctx.deps.prisma.meal.count({ where: { userId: u.id } })).toBe(0);
  });

  it('rejects a file with image magic bytes that cannot be decoded', async () => {
    const u = await registerUser(ctx);
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    const res = await uploadMeal(ctx, u, { image: fake });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_IMAGE');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(200, 2)]);
    expect((await uploadMeal(ctx, u, { image: heic })).status).toBe(422); // recognised as HEIC, then fails to decode
  });

  it('requires an image', async () => {
    const res = await ctx.http.post(`${api}/meals/analyze`).set(user.auth).field('hint', 'no file here');
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ path: 'image', issue: 'Required' }]);
  });

  it('enforces the 10 MB limit with 413', async () => {
    const small = createTestContext({ env: { UPLOAD_MAX_BYTES: '5000' } });
    const u = await registerUser(small);
    const big = await sharp(randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } }).jpeg().toBuffer();
    expect(big.length).toBeGreaterThan(5000);
    const res = await uploadMeal(small, u, { image: big });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('resizes to 1280 px, strips EXIF and stores a thumbnail', async () => {
    const u = await registerUser(ctx);
    const original = await jpeg(3000, 2000, true);
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const res = await uploadMeal(ctx, u, { image: original });
    const key = `users/${u.id}/meals/${res.body.meal.id}.jpg`;
    const stored = await sharp(ctx.storage.objects.get(key)!.body).metadata();
    expect(Math.max(stored.width!, stored.height!)).toBe(1280);
    expect(stored.exif).toBeUndefined();
    expect(ctx.storage.objects.get(key)!.body.includes(Buffer.from('secret-artist'))).toBe(false);
    const thumb = await sharp(ctx.storage.objects.get(`users/${u.id}/meals/${res.body.meal.id}_thumb.jpg`)!.body).metadata();
    expect(Math.max(thumb.width!, thumb.height!)).toBe(320);
    await ctx.queue.drain();
  });

  it('is idempotent with an Idempotency-Key', async () => {
    const u = await registerUser(ctx);
    const key = `idem-${Date.now()}`;
    ctx.queue.paused = true;
    const first = await uploadMeal(ctx, u, { idempotencyKey: key });
    const second = await uploadMeal(ctx, u, { idempotencyKey: key });
    ctx.queue.paused = false;
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.meal.id).toBe(first.body.meal.id);
    expect(await ctx.deps.prisma.meal.count({ where: { userId: u.id } })).toBe(1);
    expect(ctx.queue.enqueued.filter((e) => e.id === first.body.meal.id)).toHaveLength(1);
    // The same key from another user is a different request.
    const other = await registerUser(ctx);
    const third = await uploadMeal(ctx, other, { idempotencyKey: key });
    expect(third.body.meal.id).not.toBe(first.body.meal.id);
    await ctx.queue.drain();
  });

  it('limits uploads per user per hour', async () => {
    const limited = createTestContext({ env: { RATE_LIMIT_ANALYZE_PER_HOUR: '2' } });
    const u = await registerUser(limited);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await uploadMeal(limited, u)).status);
    expect(statuses).toEqual([202, 202, 429]);
    await limited.queue.drain();
  });

  it('shows the hint to the analyzer', async () => {
    const u = await registerUser(ctx);
    await analyzeMeal(ctx, u, { hint: 'extra cheese please' });
    expect(ctx.analyzer.calls.at(-1)?.hint).toBe('extra cheese please');
    expect(ctx.analyzer.calls.at(-1)?.image?.mimeType).toBe('image/jpeg');
  });
});

describe('analysis failures and retries', () => {
  const failed = async (hint: string) => {
    const u = await registerUser(ctx);
    ctx.analyzer.calls = [];
    const meal = await analyzeMeal(ctx, u, { hint });
    return { u, meal };
  };

  it('NOT_FOOD: marks the meal failed and notifies', async () => {
    const u = await registerUser(ctx);
    const token = `nf-${Date.now()}-${'c'.repeat(30)}`;
    await ctx.http.post(`${api}/me/devices`).set(u.auth).send({ token, platform: 'ios' });
    const meal = await analyzeMeal(ctx, u, { hint: 'notfood' });
    expect(meal).toMatchObject({ status: 'failed', errorCode: 'NOT_FOOD', progress: 0 });
    expect(meal.totals.calories).toBeNull();
    const sent = ctx.push.sent.filter((s) => s.tokens.includes(token)).at(-1)!;
    expect(sent.message.data).toMatchObject({ mealId: meal['id'], status: 'failed', errorCode: 'NOT_FOOD' });
  });

  it('LOW_CONFIDENCE', async () => {
    const { meal } = await failed('lowconf');
    expect(meal).toMatchObject({ status: 'failed', errorCode: 'LOW_CONFIDENCE' });
  });

  it('PROVIDER_ERROR without retrying a permanent failure', async () => {
    const { meal } = await failed('permanent');
    expect(meal).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' });
    expect(ctx.analyzer.calls).toHaveLength(1);
  });

  it('retries a transient provider error 3 times, then fails', async () => {
    const { meal } = await failed('transient');
    expect(meal).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' });
    expect(ctx.analyzer.calls).toHaveLength(3);
  });

  it('recovers when a transient error clears before the last attempt', async () => {
    const u = await registerUser(ctx);
    const original = ctx.analyzer.analyze.bind(ctx.analyzer);
    let n = 0;
    ctx.analyzer.analyze = async (input) => {
      n += 1;
      if (n < 3) throw new TransientError('rate limited');
      return original(input);
    };
    try {
      const meal = await analyzeMeal(ctx, u);
      expect(meal).toMatchObject({ status: 'completed', perServing: { calories: 460 } });
      expect(n).toBe(3);
    } finally {
      ctx.analyzer.analyze = original;
    }
  });

  it('asks the model once more when the JSON violates the schema', async () => {
    const { meal } = await failed('badjson');
    expect(meal.status).toBe('completed');
    expect(ctx.analyzer.calls).toHaveLength(2);
    const { meal: still } = await failed('badjsonalways');
    expect(still).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' });
    expect(ctx.analyzer.calls).toHaveLength(2); // exactly one retry, not an endless loop
  });

  it('clamps implausible values from the model', async () => {
    const { meal } = await failed('huge');
    expect(meal.status).toBe('completed');
    expect(meal.perServing.calories).toBe(5000);
  });

  it('lets the user rescue a failed meal by entering all four values', async () => {
    const { u, meal } = await failed('notfood');
    const partial = await ctx.http.patch(`${api}/meals/${meal['id']}`).set(u.auth).send({ calories: 300 });
    expect(partial.status).toBe(422);
    expect(partial.body.error.code).toBe('MANUAL_VALUES_INCOMPLETE');
    const ok = await ctx.http
      .patch(`${api}/meals/${meal['id']}`)
      .set(u.auth)
      .send({ name: 'Plain rice', calories: 300, proteinG: 6, carbsG: 65, fatG: 1 });
    expect(ok.body.meal).toMatchObject({ status: 'completed', errorCode: null, totals: { calories: 300 } });
  });

  it('skips a meal that was deleted before the worker got to it', async () => {
    const u = await registerUser(ctx);
    ctx.queue.paused = true;
    const res = await uploadMeal(ctx, u);
    await ctx.http.delete(`${api}/meals/${res.body.meal.id}`).set(u.auth);
    ctx.queue.paused = false;
    ctx.analyzer.calls = [];
    await ctx.queue.enqueueMealAnalysis(res.body.meal.id);
    await ctx.queue.drain();
    expect(ctx.analyzer.calls).toHaveLength(0);
  });
});

describe('GET, PATCH and DELETE /meals/:id', () => {
  it('scales totals by quantity while per-serving values stay put', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u);
    const res = await ctx.http.patch(`${api}/meals/${meal['id']}`).set(u.auth).send({ quantity: 2 });
    expect(res.body.meal).toMatchObject({
      quantity: 2,
      perServing: { calories: 460, proteinG: 25, carbsG: 45, fatG: 20 },
      totals: { calories: 920, proteinG: 50, carbsG: 90, fatG: 40 },
    });
    const half = await ctx.http.patch(`${api}/meals/${meal['id']}`).set(u.auth).send({ quantity: 0.5 });
    expect(half.body.meal.totals).toEqual({ calories: 230, proteinG: 12.5, carbsG: 22.5, fatG: 10 });
    expect((await ctx.http.patch(`${api}/meals/${meal['id']}`).set(u.auth).send({ quantity: 0.1 })).status).toBe(400);
    expect((await ctx.http.patch(`${api}/meals/${meal['id']}`).set(u.auth).send({ quantity: 21 })).status).toBe(400);
  });

  it('edits name, nutrition and time', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u);
    const res = await ctx.http
      .patch(`${api}/meals/${meal['id']}`)
      .set(u.auth)
      .send({ name: 'My lunch', calories: 500, proteinG: 30.5, carbsG: 40, fatG: 18, loggedAt: '2026-03-04T05:06:07Z' });
    expect(res.body.meal).toMatchObject({ name: 'My lunch', perServing: { calories: 500, proteinG: 30.5 }, loggedAt: '2026-03-04T05:06:07.000Z' });
    expect((await ctx.http.patch(`${api}/meals/${meal['id']}`).set(u.auth).send({})).status).toBe(400);
    expect((await ctx.http.patch(`${api}/meals/${meal['id']}`).set(u.auth).send({ calories: -1 })).status).toBe(400);
  });

  it('refuses edits while the meal is being analyzed', async () => {
    const u = await registerUser(ctx);
    ctx.queue.paused = true;
    const res = await uploadMeal(ctx, u);
    ctx.queue.paused = false;
    const patch = await ctx.http.patch(`${api}/meals/${res.body.meal.id}`).set(u.auth).send({ name: 'x' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('MEAL_BUSY');
  });

  it('soft deletes: gone from reads and lists, row kept', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u);
    expect((await ctx.http.delete(`${api}/meals/${meal['id']}`).set(u.auth)).status).toBe(204);
    expect((await ctx.http.get(`${api}/meals/${meal['id']}`).set(u.auth)).status).toBe(404);
    expect((await ctx.http.delete(`${api}/meals/${meal['id']}`).set(u.auth)).status).toBe(404);
    expect((await ctx.http.get(`${api}/meals`).set(u.auth)).body.items).toHaveLength(0);
    const row = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id: meal['id'] } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('rejects malformed ids with 400 and unknown ids with 404', async () => {
    expect((await ctx.http.get(`${api}/meals/not-a-uuid`).set(user.auth)).status).toBe(400);
    expect((await ctx.http.get(`${api}/meals/6f1c0d52-5d1e-4c8e-9a43-0e0a6d3d9b11`).set(user.auth)).status).toBe(404);
  });
});

describe('POST /meals/:id/fix (Fix Results)', () => {
  it('re-queues with the correction and keeps the previous values until the new result lands', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u);
    ctx.analyzer.calls = [];

    ctx.queue.paused = true;
    const fix = await ctx.http
      .post(`${api}/meals/${meal['id']}/fix`)
      .set(u.auth)
      .send({ instruction: 'that was chicken, not turkey, and no chips' });
    ctx.queue.paused = false;
    expect(fix.status).toBe(202);
    expect(fix.body.meal).toMatchObject({
      status: 'queued',
      reanalyzing: true,
      perServing: { calories: 460 }, // still the old result
      totals: { calories: 460 },
    });
    expect(await ctx.deps.prisma.mealCorrection.count({ where: { mealId: meal['id'] } })).toBe(1);
    // A second fix while re-analyzing is refused.
    expect((await ctx.http.post(`${api}/meals/${meal['id']}/fix`).set(u.auth).send({ instruction: 'again please' })).status).toBe(409);

    await ctx.queue.enqueueMealAnalysis(meal['id']);
    await ctx.queue.drain();
    const fixed = await getMeal(u, meal['id']);
    expect(fixed).toMatchObject({ name: 'Chicken Sandwich', status: 'completed', reanalyzing: false, healthScore: 8, perServing: { calories: 340 } });

    const call = ctx.analyzer.calls[0]!;
    expect(call.corrections).toEqual(['that was chicken, not turkey, and no chips']);
    expect(call.previous?.calories).toBe(460);
    expect(call.image).toBeDefined(); // the original image is sent again
  });

  it('keeps the old values and reports the error when the re-analysis fails', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u);
    const original = ctx.analyzer.analyze.bind(ctx.analyzer);
    ctx.analyzer.analyze = async () => {
      throw new ProviderError('boom');
    };
    try {
      await ctx.http.post(`${api}/meals/${meal['id']}/fix`).set(u.auth).send({ instruction: 'it was a salad' });
      await ctx.queue.drain();
    } finally {
      ctx.analyzer.analyze = original;
    }
    const after = await getMeal(u, meal['id']);
    expect(after).toMatchObject({ status: 'completed', errorCode: 'PROVIDER_ERROR', perServing: { calories: 460 }, name: 'Turkey Sandwich, Potato Chips' });
    // A later successful fix clears the error.
    await ctx.http.post(`${api}/meals/${meal['id']}/fix`).set(u.auth).send({ instruction: 'it was chicken' });
    await ctx.queue.drain();
    expect((await getMeal(u, meal['id'])).errorCode).toBeNull();
  });

  it('accumulates corrections, oldest first', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u);
    await ctx.http.post(`${api}/meals/${meal['id']}/fix`).set(u.auth).send({ instruction: 'first correction' });
    await ctx.queue.drain();
    ctx.analyzer.calls = [];
    await ctx.http.post(`${api}/meals/${meal['id']}/fix`).set(u.auth).send({ instruction: 'second correction' });
    await ctx.queue.drain();
    expect(ctx.analyzer.calls[0]!.corrections).toEqual(['first correction', 'second correction']);
  });

  it('is not available for manual or barcode meals', async () => {
    const u = await registerUser(ctx);
    const manual = await ctx.http.post(`${api}/meals`).set(u.auth).send({ name: 'Toast', calories: 200, proteinG: 6, carbsG: 30, fatG: 5 });
    const res = await ctx.http.post(`${api}/meals/${manual.body.meal.id}/fix`).set(u.auth).send({ instruction: 'it was bigger' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FIX_NOT_SUPPORTED');
  });

  it('requires an instruction', async () => {
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u);
    expect((await ctx.http.post(`${api}/meals/${meal['id']}/fix`).set(u.auth).send({})).status).toBe(400);
  });
});

describe('POST /meals (manual and text)', () => {
  it('creates a completed manual meal', async () => {
    const u = await registerUser(ctx);
    const res = await ctx.http
      .post(`${api}/meals`)
      .set(u.auth)
      .send({ name: 'Greek yogurt', calories: 150, proteinG: 15, carbsG: 8, fatG: 5.5, quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.meal).toMatchObject({
      source: 'manual',
      status: 'completed',
      progress: 100,
      totals: { calories: 300, proteinG: 30, carbsG: 16, fatG: 11 },
    });
    expect(ctx.queue.enqueued.some((e) => e.id === res.body.meal.id)).toBe(false);
  });

  it('names every missing field', async () => {
    const res = await ctx.http.post(`${api}/meals`).set(user.auth).send({ name: 'Half a meal', calories: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: any) => d.path).sort()).toEqual(['carbsG', 'fatG', 'proteinG']);
  });

  it('queues an AI estimate for a text description', async () => {
    const u = await registerUser(ctx);
    const res = await ctx.http.post(`${api}/meals`).set(u.auth).send({ description: 'two eggs and toast' });
    expect(res.status).toBe(202);
    expect(res.body.meal).toMatchObject({ source: 'text', status: 'queued' });
    await ctx.queue.drain();
    const meal = await getMeal(u, res.body.meal.id);
    expect(meal).toMatchObject({ status: 'completed', name: 'Two eggs and toast', imageUrl: null });
    expect(ctx.analyzer.calls.at(-1)?.description).toBe('two eggs and toast');
    expect(ctx.analyzer.calls.at(-1)?.image).toBeUndefined();
    // Text meals can be fixed too.
    expect((await ctx.http.post(`${api}/meals/${meal.id}/fix`).set(u.auth).send({ instruction: 'it was three eggs' })).status).toBe(202);
    await ctx.queue.drain();
  });
});

describe('POST /meals/barcode', () => {
  it('creates a completed meal from the product data and caches the lookup', async () => {
    const u = await registerUser(ctx);
    const before = ctx.products.lookups;
    const res = await ctx.http.post(`${api}/meals/barcode`).set(u.auth).send({ barcode: '3017620422003', quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.meal).toMatchObject({
      source: 'barcode',
      status: 'completed',
      name: 'Nutella Hazelnut Spread',
      barcode: '3017620422003',
      healthScore: 2,
      perServing: { calories: 80, proteinG: 0.9, carbsG: 8.6, fatG: 4.6 },
      totals: { calories: 160, proteinG: 1.8, carbsG: 17.2, fatG: 9.2 },
      thumbnailUrl: 'https://images.example.com/spread.jpg',
    });
    await ctx.http.post(`${api}/meals/barcode`).set(u.auth).send({ barcode: '3017620422003' });
    expect(ctx.products.lookups - before).toBe(1);
  });

  it('answers 404 PRODUCT_NOT_FOUND so the client can fall back to manual entry', async () => {
    const res = await ctx.http.post(`${api}/meals/barcode`).set(user.auth).send({ barcode: '0000000000000' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('validates the barcode format', async () => {
    expect((await ctx.http.post(`${api}/meals/barcode`).set(user.auth).send({ barcode: 'abc' })).status).toBe(400);
  });
});

describe('GET /meals', () => {
  it('lists newest first and paginates with a cursor', async () => {
    const u = await registerUser(ctx);
    const times = ['2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z', '2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z', '2026-05-01T12:00:00Z'];
    for (const [i, t] of times.entries()) {
      await ctx.http.post(`${api}/meals`).set(u.auth).send({ name: `Meal ${i}`, calories: 100, proteinG: 1, carbsG: 1, fatG: 1, loggedAt: t });
    }
    const page1 = await ctx.http.get(`${api}/meals`).set(u.auth).query({ limit: 2 });
    expect(page1.body.items.map((m: any) => m.name)).toEqual(['Meal 4', 'Meal 3']);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await ctx.http.get(`${api}/meals`).set(u.auth).query({ limit: 2, cursor: page1.body.nextCursor });
    expect(page2.body.items.map((m: any) => m.name)).toEqual(['Meal 2', 'Meal 1']);
    const page3 = await ctx.http.get(`${api}/meals`).set(u.auth).query({ limit: 2, cursor: page2.body.nextCursor });
    expect(page3.body.items.map((m: any) => m.name)).toEqual(['Meal 0']);
    expect(page3.body.nextCursor).toBeNull();
    expect((await ctx.http.get(`${api}/meals`).set(u.auth).query({ cursor: 'garbage' })).body.error.code).toBe('INVALID_CURSOR');
  });

  it('does not skip meals that share a timestamp', async () => {
    const u = await registerUser(ctx);
    for (let i = 0; i < 4; i++) {
      await ctx.http.post(`${api}/meals`).set(u.auth).send({ name: `Same ${i}`, calories: 1, proteinG: 0, carbsG: 0, fatG: 0, loggedAt: '2026-05-02T08:00:00Z' });
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const res = await ctx.http.get(`${api}/meals`).set(u.auth).query({ limit: 1, ...(cursor ? { cursor } : {}) });
      res.body.items.forEach((m: any) => seen.add(m.id));
      cursor = res.body.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBe(4);
  });

  it('filters by calendar day in the user\'s timezone, or the X-Timezone header', async () => {
    const u = await registerUser(ctx); // timezone Asia/Phnom_Penh (UTC+7)
    // 2026-06-10 18:30 UTC is 2026-06-11 01:30 in Phnom Penh, and 2026-06-10 11:30 in Los Angeles.
    await ctx.http.post(`${api}/meals`).set(u.auth).send({ name: 'Late snack', calories: 100, proteinG: 1, carbsG: 1, fatG: 1, loggedAt: '2026-06-10T18:30:00Z' });
    const inPhnomPenh = await ctx.http.get(`${api}/meals`).set(u.auth).query({ date: '2026-06-11' });
    expect(inPhnomPenh.body.items).toHaveLength(1);
    expect((await ctx.http.get(`${api}/meals`).set(u.auth).query({ date: '2026-06-10' })).body.items).toHaveLength(0);
    const inLa = await ctx.http.get(`${api}/meals`).set(u.auth).set('X-Timezone', 'America/Los_Angeles').query({ date: '2026-06-10' });
    expect(inLa.body.items).toHaveLength(1);
    expect(inLa.body.date).toBe('2026-06-10');
  });

  it('rejects an impossible date', async () => {
    expect((await ctx.http.get(`${api}/meals`).set(user.auth).query({ date: '2026-02-30' })).status).toBe(400);
  });
});
