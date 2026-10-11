import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type Meal } from '@prisma/client';
import type { AppDeps } from '../../deps';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { processImage, sniffImageKind } from '../../lib/image';
import { dayRange, resolveDateParam } from '../../lib/time';
import { mealImageKey, mealThumbKey } from '../../lib/storage';
import { foodPhotoPath } from '../../lib/food-photos';
import { createDishResolver, summarize } from './dish-resolver';
import { waitForMealSettled } from '../../lib/meal-events';
import { createMealMapper } from './meals.mapper';
import type { AuthUser } from '../../lib/http/route';

const QUEUED_PROGRESS = 5;
const FUTURE_SKEW_MS = 24 * 3600_000;

interface PatchInput {
  name?: string;
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  quantity?: number;
  loggedAt?: string;
}

const encodeCursor = (m: Pick<Meal, 'loggedAt' | 'id'>) =>
  Buffer.from(JSON.stringify({ t: m.loggedAt.toISOString(), id: m.id })).toString('base64url');

function decodeCursor(cursor: string): { t: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t: string; id: string };
    const t = new Date(parsed.t);
    if (Number.isNaN(t.getTime()) || typeof parsed.id !== 'string') throw new Error('bad cursor');
    return { t, id: parsed.id };
  } catch {
    throw badRequest('INVALID_CURSOR', 'The cursor is not valid', [{ path: 'cursor', issue: 'Not a valid cursor' }]);
  }
}

/**
 * When a meal is a single recognised dish, its edited per serving values become this user's values for that
 * dish (divided by the portion, so they are per standard serving). Meals of several dishes can't say which
 * dish was wrong, so they only keep the edit as a label.
 */
async function rememberCorrection(tx: Prisma.TransactionClient, meal: Meal): Promise<void> {
  const components = await tx.mealComponent.findMany({ where: { mealId: meal.id } });
  if (components.length !== 1 || meal.calories === null) return;
  const [c] = components as [(typeof components)[number]];
  const per = (v: number | null) => Math.round(((v ?? 0) / c.portion) * 10) / 10;
  const values = {
    calories: Math.round(meal.calories / c.portion),
    proteinG: per(meal.proteinG),
    carbsG: per(meal.carbsG),
    fatG: per(meal.fatG),
    sourceMealId: meal.id,
  };
  await tx.userDishOverride.upsert({
    where: { userId_dishId: { userId: meal.userId, dishId: c.dishId } },
    create: { userId: meal.userId, dishId: c.dishId, ...values },
    update: values,
  });
}

export function createMealsService(deps: AppDeps) {
  const { prisma, storage, queue, config, clock, productLookup } = deps;
  const mapper = createMealMapper(storage, prisma, config.publicBaseUrl);
  const resolver = createDishResolver(prisma, { maxCalories: config.ai.maxCaloriesPerServing, now: clock });

  /** Every lookup is scoped by userId. Another user's meal is indistinguishable from a missing one (404). */
  async function findOwned(userId: string, id: string): Promise<Meal> {
    const meal = await prisma.meal.findFirst({ where: { id, userId, deletedAt: null } });
    if (!meal) throw notFound('MEAL_NOT_FOUND', 'Meal not found');
    return meal;
  }

  function parseLoggedAt(value: string | undefined): Date {
    if (!value) return clock();
    const d = new Date(value);
    if (d.getTime() > clock().getTime() + FUTURE_SKEW_MS) {
      throw badRequest('VALIDATION_ERROR', 'loggedAt is too far in the future', [
        { path: 'loggedAt', issue: 'Too far in the future' },
      ]);
    }
    return d;
  }

  async function enqueueOrRevert(meal: Meal, revert: () => Promise<unknown>, image?: Buffer): Promise<void> {
    try {
      await queue.enqueueMealAnalysis(meal.id, image);
    } catch (err) {
      deps.logger.error({ err, mealId: meal.id }, 'could not enqueue meal analysis');
      await revert().catch(() => undefined);
      throw new AppError(503, 'QUEUE_UNAVAILABLE', 'Analysis is temporarily unavailable. Please try again.');
    }
  }

  /** Uploads that are still running, so tests (and a graceful shutdown) can wait for them. */
  const pendingUploads = new Set<Promise<void>>();

  /**
   * Stores a meal's photo and thumbnail in the background. If storage fails the meal still works (it was
   * analyzed from memory); it just has no picture, so its image keys are cleared and the failure is logged.
   */
  function storeMealPhotos(mealId: string, files: [key: string, body: Buffer][]): void {
    const task = Promise.all(files.map(([key, body]) => storage.put(key, body, 'image/jpeg')))
      .then(() => undefined)
      .catch(async (err: unknown) => {
        deps.logger.error({ mealId, err: (err as Error).message }, 'meal photo upload failed; meal kept without photo');
        await prisma.meal
          .updateMany({ where: { id: mealId }, data: { imageKey: null, thumbKey: null } })
          .catch(() => undefined);
        await Promise.all(files.map(([key]) => storage.delete(key))).catch(() => undefined);
      });
    pendingUploads.add(task);
    void task.finally(() => pendingUploads.delete(task));
  }

  return {
    mapper,

    /** Resolves when every background photo upload has finished. */
    async settleUploads(): Promise<void> {
      while (pendingUploads.size) await Promise.all([...pendingUploads]);
    },

    /** POST /meals/analyze. Stores the processed image, creates a queued meal and returns immediately (202). */
    async analyzeImage(
      user: AuthUser,
      input: {
        file: Express.Multer.File | undefined;
        loggedAt?: string;
        source?: 'camera' | 'gallery';
        hint?: string;
        idempotencyKey?: string;
      },
    ) {
      if (!input.file) {
        throw badRequest('VALIDATION_ERROR', 'An image file is required', [{ path: 'image', issue: 'Required' }]);
      }
      // Magic bytes decide, not the client-supplied Content-Type or file name.
      const kind = sniffImageKind(input.file.buffer);
      if (!kind) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a JPEG, PNG, WebP or HEIC image');
      }
      if (input.idempotencyKey) {
        if (input.idempotencyKey.length > 200) {
          throw badRequest('VALIDATION_ERROR', 'Idempotency-Key is too long');
        }
        const existing = await prisma.meal.findUnique({
          where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: input.idempotencyKey } },
        });
        if (existing) return mapper.detail(existing);
      }
      const loggedAt = parseLoggedAt(input.loggedAt);
      const processed = await processImage(input.file.buffer, kind, config.uploads.maxDimension);

      const id = randomUUID();
      const imageKey = mealImageKey(user.id, id);
      const thumbKey = mealThumbKey(user.id, id);

      let meal: Meal;
      try {
        meal = await prisma.meal.create({
          data: {
            id,
            userId: user.id,
            source: 'photo',
            captureMethod: input.source ?? null,
            status: 'queued',
            progress: QUEUED_PROGRESS,
            imageKey,
            thumbKey,
            hint: input.hint || null,
            imageSha256: createHash('sha256').update(input.file.buffer).digest('hex'),
            idempotencyKey: input.idempotencyKey ?? null,
            loggedAt,
          },
        });
      } catch (err) {
        // Two identical requests raced: the loser returns the winner's meal.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && input.idempotencyKey) {
          const winner = await prisma.meal.findUnique({
            where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: input.idempotencyKey } },
          });
          if (winner) return mapper.detail(winner);
        }
        throw err;
      }

      // The analysis starts with the photo already in memory; storing it (about 3 to 4 s to Cloudinary) runs in
      // parallel instead of in front of it (spec 0003). Nothing is stored yet if enqueueing fails.
      await enqueueOrRevert(meal, () => prisma.meal.delete({ where: { id } }), processed.full);
      storeMealPhotos(id, [
        [imageKey, processed.full],
        [thumbKey, processed.thumb],
      ]);
      return mapper.detail(meal);
    },

    /** POST /meals/barcode. Creates a completed meal from the product's per-serving data. */
    async fromBarcode(user: AuthUser, input: { barcode: string; loggedAt?: string; quantity?: number }) {
      const loggedAt = parseLoggedAt(input.loggedAt);
      const product = await productLookup.findByBarcode(input.barcode);
      if (!product) {
        throw notFound('PRODUCT_NOT_FOUND', 'We could not find that product. You can enter it manually.');
      }
      const meal = await prisma.meal.create({
        data: {
          userId: user.id,
          name: product.brand && !product.name.toLowerCase().includes(product.brand.toLowerCase())
            ? `${product.brand} ${product.name}`
            : product.name,
          source: 'barcode',
          status: 'completed',
          progress: 100,
          barcode: product.barcode,
          externalImageUrl: product.imageUrl,
          quantity: input.quantity ?? 1,
          calories: product.calories,
          proteinG: product.proteinG,
          carbsG: product.carbsG,
          fatG: product.fatG,
          healthScore: product.healthScore,
          items: [
            {
              name: product.name,
              portion: product.servingSize ?? '1 serving',
              calories: product.calories,
              proteinG: product.proteinG,
              carbsG: product.carbsG,
              fatG: product.fatG,
            },
          ],
          analyzedAt: clock(),
          loggedAt,
        },
      });
      return mapper.detail(meal);
    },

    /** POST /meals/from-food: one catalog dish becomes a completed meal at once (portion 1, the user's own values win). */
    async fromFood(user: AuthUser, input: { dishSlug: string; quantity?: number; loggedAt?: string }) {
      const dish = await prisma.foodDish.findFirst({ where: { slug: input.dishSlug, kind: 'catalog' } });
      if (!dish) throw notFound('FOOD_NOT_FOUND', 'Food not found');
      const loggedAt = parseLoggedAt(input.loggedAt);
      const [c] = await resolver.compute(user.id, [{ dish, portion: 1 }]);
      const totals = summarize([c!], config.ai.maxCaloriesPerServing);
      const photo = foodPhotoPath(dish.slug);
      const meal = await prisma.meal.create({
        data: {
          userId: user.id,
          name: totals.name,
          nameKm: totals.nameKm,
          source: 'catalog',
          status: 'completed',
          progress: 100,
          // Relative on purpose: the mapper adds the public base URL, so a changed host never breaks stored meals.
          externalImageUrl: photo,
          quantity: input.quantity ?? 1,
          calories: totals.calories,
          proteinG: totals.proteinG,
          carbsG: totals.carbsG,
          fatG: totals.fatG,
          healthScore: totals.healthScore,
          items: [
            {
              name: dish.nameEn,
              portion: dish.servingDescription,
              calories: totals.calories,
              proteinG: totals.proteinG,
              carbsG: totals.carbsG,
              fatG: totals.fatG,
            },
          ],
          analyzedAt: clock(),
          loggedAt,
          components: {
            create: {
              dishId: dish.id,
              position: 0,
              portion: 1,
              calories: c!.calories,
              proteinG: c!.proteinG,
              carbsG: c!.carbsG,
              fatG: c!.fatG,
              healthScore: c!.healthScore,
              valueSource: c!.valueSource,
            },
          },
        },
      });
      return mapper.detail(meal);
    },

    /** POST /meals with manual values: a completed meal, no AI involved. */
    async createManual(
      user: AuthUser,
      input: { name: string; calories: number; proteinG: number; carbsG: number; fatG: number; quantity?: number; loggedAt?: string },
    ) {
      const meal = await prisma.meal.create({
        data: {
          userId: user.id,
          name: input.name,
          source: 'manual',
          status: 'completed',
          progress: 100,
          quantity: input.quantity ?? 1,
          calories: input.calories,
          proteinG: input.proteinG,
          carbsG: input.carbsG,
          fatG: input.fatG,
          analyzedAt: clock(),
          loggedAt: parseLoggedAt(input.loggedAt),
        },
      });
      return mapper.detail(meal);
    },

    /** POST /meals with a description: queues a text-based AI estimate (202). */
    async createFromText(user: AuthUser, input: { description: string; loggedAt?: string }) {
      const meal = await prisma.meal.create({
        data: {
          userId: user.id,
          source: 'text',
          status: 'queued',
          progress: QUEUED_PROGRESS,
          description: input.description,
          loggedAt: parseLoggedAt(input.loggedAt),
        },
      });
      await enqueueOrRevert(meal, () => prisma.meal.delete({ where: { id: meal.id } }));
      return mapper.detail(meal);
    },

    /**
     * Waits up to `seconds` for a meal's analysis to settle (completed or failed), then returns it. `settled` is
     * false when the time ran out and the meal is still queued or analyzing.
     */
    async waitForResult(user: AuthUser, id: string, seconds: number) {
      const isSettled = async () => {
        const row = await prisma.meal.findFirst({ where: { id, userId: user.id, deletedAt: null }, select: { status: true } });
        return !row || (row.status !== 'queued' && row.status !== 'analyzing');
      };
      const settled = (await isSettled()) || (await waitForMealSettled(id, seconds * 1000, isSettled));
      return { meal: await mapper.detail(await findOwned(user.id, id)), settled };
    },

    async get(user: AuthUser, id: string) {
      return mapper.detail(await findOwned(user.id, id));
    },

    /** Newest first, one calendar day in the user's timezone when `date` is given. */
    async list(user: AuthUser, zone: string, q: { date?: string; limit: number; cursor?: string }) {
      const where: Prisma.MealWhereInput = { userId: user.id, deletedAt: null };
      let date: string | null = null;
      if (q.date) {
        date = resolveDateParam(q.date, zone, clock());
        const { start, end } = dayRange(date, zone);
        where.loggedAt = { gte: start, lt: end };
      }
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        where.AND = [{ OR: [{ loggedAt: { lt: c.t } }, { loggedAt: c.t, id: { lt: c.id } }] }];
      }
      const rows = await prisma.meal.findMany({
        where,
        orderBy: [{ loggedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return {
        items: await Promise.all(page.map((m) => mapper.summary(m))),
        nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null,
        date,
      };
    },

    /** Values are per serving. Quantity scales them; totals are computed on read. */
    async patch(user: AuthUser, id: string, patch: PatchInput) {
      const meal = await findOwned(user.id, id);
      if (meal.status === 'queued' || meal.status === 'analyzing') {
        throw conflict('MEAL_BUSY', 'This meal is still being analyzed. Try again when it finishes.');
      }

      const data: Prisma.MealUpdateInput = {};
      // A renamed meal no longer matches the recognised dishes' Khmer name.
      if (patch.name !== undefined && patch.name !== meal.name) {
        data.name = patch.name;
        data.nameKm = null;
      }
      if (patch.quantity !== undefined) data.quantity = patch.quantity;
      if (patch.loggedAt !== undefined) data.loggedAt = parseLoggedAt(patch.loggedAt);
      const nutritionKeys = ['calories', 'proteinG', 'carbsG', 'fatG'] as const;
      for (const k of nutritionKeys) if (patch[k] !== undefined) data[k] = patch[k];

      if (meal.analyzedAt === null) {
        // A failed analysis can be rescued by typing the values in: all four are needed to make it countable.
        const touched = nutritionKeys.filter((k) => patch[k] !== undefined);
        if (touched.length) {
          const missing = nutritionKeys.filter((k) => patch[k] === undefined && meal[k] === null);
          if (missing.length) {
            throw unprocessable(
              'MANUAL_VALUES_INCOMPLETE',
              'Enter calories, protein, carbs and fat together.',
              missing.map((path) => ({ path, issue: 'Required' })),
            );
          }
          data.status = 'completed';
          data.progress = 100;
          data.errorCode = null;
          data.analyzedAt = clock();
        }
      }

      const valuesChanged = nutritionKeys.some((k) => patch[k] !== undefined && patch[k] !== meal[k]);
      if (valuesChanged) {
        // A correction: the strongest label for training, and this user's own values for the dish next time.
        data.userEditedAt = clock();
        if (meal.originalNutrition === null && meal.calories !== null) {
          data.originalNutrition = { calories: meal.calories, proteinG: meal.proteinG, carbsG: meal.carbsG, fatG: meal.fatG };
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.meal.update({ where: { id: meal.id }, data });
        if (valuesChanged) await rememberCorrection(tx, row);
        return row;
      });
      return mapper.detail(updated);
    },

    /**
     * "Fix Results": saves the correction and re-queues analysis with the original image plus every correction.
     * The previous values stay in place (and keep counting) until the new result lands.
     */
    async fix(user: AuthUser, id: string, instruction: string) {
      const meal = await findOwned(user.id, id);
      if (meal.source !== 'photo' && meal.source !== 'text') {
        throw unprocessable('FIX_NOT_SUPPORTED', 'Only photo and text meals can be re-analyzed. Edit the values instead.');
      }
      if (meal.status === 'queued' || meal.status === 'analyzing') {
        throw conflict('MEAL_BUSY', 'This meal is already being analyzed.');
      }
      const [, queued] = await prisma.$transaction([
        prisma.mealCorrection.create({ data: { mealId: meal.id, instruction } }),
        prisma.meal.update({
          where: { id: meal.id },
          data: { status: 'queued', progress: QUEUED_PROGRESS, errorCode: null },
        }),
      ]);
      await enqueueOrRevert(queued, () =>
        prisma.meal.update({
          where: { id: meal.id },
          data: { status: meal.status, progress: meal.progress, errorCode: meal.errorCode },
        }),
      );
      return mapper.detail(queued);
    },

    /** Soft delete (the "..." menu). */
    async remove(user: AuthUser, id: string): Promise<void> {
      const res = await prisma.meal.updateMany({
        where: { id, userId: user.id, deletedAt: null },
        data: { deletedAt: clock() },
      });
      if (res.count === 0) throw notFound('MEAL_NOT_FOUND', 'Meal not found');
    },
  };
}

export type MealsService = ReturnType<typeof createMealsService>;
