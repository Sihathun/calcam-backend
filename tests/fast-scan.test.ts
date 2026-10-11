import { describe, expect, it, vi } from 'vitest';
import { BullJobQueue } from '../src/lib/queue/bullmq';
import { createTestContext, jpeg, registerUser, uploadMeal } from './helpers';

// Spec 0003: the photo goes straight from the upload to the analysis, storage runs in parallel, and the upload
// request can wait for the result.

const api = '/api/v1';
const ctx = createTestContext();

/** Background storage finishes within a few ticks for in-memory storage; wait for it explicitly. */
async function eventually(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('POST /meals/analyze?wait', () => {
  it('answers 200 with the finished meal when the analysis settles in time', async () => {
    const u = await registerUser(ctx);
    const res = await ctx.http
      .post(`${api}/meals/analyze`)
      .set(u.auth)
      .attach('image', await jpeg(), { filename: 'meal.jpg', contentType: 'image/jpeg' })
      .field('hint', 'catalog:kuy-teav@1')
      .field('wait', '10');
    expect(res.status).toBe(200);
    expect(res.body.meal).toMatchObject({ status: 'completed', progress: 100 });
    expect(res.body.meal.components[0]).toMatchObject({ dishSlug: 'kuy-teav' });
  });

  it('also takes wait as a query parameter, and answers 200 for a failed analysis', async () => {
    const u = await registerUser(ctx);
    const res = await ctx.http
      .post(`${api}/meals/analyze?wait=10`)
      .set(u.auth)
      .attach('image', await jpeg(), { filename: 'meal.jpg', contentType: 'image/jpeg' })
      .field('hint', 'notfood');
    expect(res.status).toBe(200);
    expect(res.body.meal).toMatchObject({ status: 'failed', errorCode: 'NOT_FOOD' });
  });

  it('answers 202 with the queued meal when the time runs out', async () => {
    const u = await registerUser(ctx);
    ctx.queue.paused = true;
    try {
      const started = Date.now();
      const res = await ctx.http
        .post(`${api}/meals/analyze`)
        .set(u.auth)
        .attach('image', await jpeg(), { filename: 'meal.jpg', contentType: 'image/jpeg' })
        .field('wait', '1');
      expect(res.status).toBe(202);
      expect(res.body.meal.status).toBe('queued');
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      ctx.queue.paused = false;
    }
  });

  it('keeps answering 202 at once without wait, and rejects a wait above 25 s', async () => {
    const u = await registerUser(ctx);
    const res = await uploadMeal(ctx, u);
    expect(res.status).toBe(202);
    const tooLong = await ctx.http
      .post(`${api}/meals/analyze?wait=60`)
      .set(u.auth)
      .attach('image', await jpeg(), { filename: 'meal.jpg', contentType: 'image/jpeg' });
    expect(tooLong.status).toBe(400);
    await ctx.queue.drain();
  });
});

describe('photo hand-over and background storage', () => {
  it('analyzes a fresh upload from memory, without downloading it from storage', async () => {
    const u = await registerUser(ctx);
    const get = vi.spyOn(ctx.storage, 'get');
    try {
      const res = await ctx.http
        .post(`${api}/meals/analyze`)
        .set(u.auth)
        .attach('image', await jpeg(), { filename: 'meal.jpg', contentType: 'image/jpeg' })
        .field('hint', 'catalog:bai-cha@1')
        .field('wait', '10');
      expect(res.body.meal.status).toBe('completed');
      expect(ctx.analyzer.calls.at(-1)?.image?.mimeType).toBe('image/jpeg');
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  it('still stores the photo and thumbnail, in the background', async () => {
    const u = await registerUser(ctx);
    const res = await uploadMeal(ctx, u, { hint: 'catalog:bai-cha@1' });
    await ctx.queue.drain();
    const stored = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id: res.body.meal.id } });
    await eventually(() => ctx.storage.objects.has(stored.imageKey!) && ctx.storage.objects.has(stored.thumbKey!));
  });

  it('keeps the meal when storage fails: analyzed from memory, image keys cleared', async () => {
    const u = await registerUser(ctx);
    const put = vi.spyOn(ctx.storage, 'put').mockRejectedValue(new Error('Cloudinary is down'));
    try {
      const res = await ctx.http
        .post(`${api}/meals/analyze`)
        .set(u.auth)
        .attach('image', await jpeg(), { filename: 'meal.jpg', contentType: 'image/jpeg' })
        .field('hint', 'catalog:mi-cha@1')
        .field('wait', '10');
      expect(res.body.meal.status).toBe('completed');
      const id = res.body.meal.id as string;
      let row = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id } });
      const until = Date.now() + 2000;
      while (row.imageKey && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 20));
        row = await ctx.deps.prisma.meal.findUniqueOrThrow({ where: { id } });
      }
      expect(row).toMatchObject({ status: 'completed', imageKey: null, thumbKey: null });
    } finally {
      put.mockRestore();
    }
  });
});

describe('BullMQ carries the photo in the job', () => {
  it('stores it as base64 and drops the job from Redis once it is done', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    // Only the pieces enqueueMealAnalysis touches, so no Redis connection is needed.
    const queue = Object.assign(Object.create(BullJobQueue.prototype), { meals: { add }, config: ctx.config }) as BullJobQueue;
    await queue.enqueueMealAnalysis('meal-1', Buffer.from('jpeg-bytes'));
    expect(add.mock.calls[0]![1]).toEqual({ mealId: 'meal-1', image: Buffer.from('jpeg-bytes').toString('base64') });
    expect(add.mock.calls[0]![2]).toMatchObject({ removeOnComplete: true, removeOnFail: { age: 86400 } });

    await queue.enqueueMealAnalysis('meal-2'); // a re-analysis carries no photo and keeps the job history
    expect(add.mock.calls[1]![1]).toEqual({ mealId: 'meal-2' });
    expect(add.mock.calls[1]![2]).toMatchObject({ removeOnComplete: { count: 1000 } });
  });
});
