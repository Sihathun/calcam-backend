import type { Prisma } from '@prisma/client';
import type { WorkerDeps } from '../../deps';
import type { AnalyzerInput, AnalyzerOutput } from '../../lib/analyzer';
import { PROMPT_VERSION } from '../../lib/analyzer/prompts/meal-analysis.v2';
import { aiMealSchema, type AiMeal } from '../../lib/analyzer/schema';
import type { MealErrorCode } from '../../lib/enums';
import { TransientError } from '../../lib/errors';
import { notifyMeal } from '../../lib/notify';
import type { JobAttempt } from '../../lib/queue';
import { createDishResolver, summarize, type ResolvedComponent } from './dish-resolver';

/** Progress is stage-based on purpose: the client never sees fake smooth percentages. */
const PROGRESS = { imageReady: 20, modelAnswered: 50, validated: 90, done: 100 } as const;

class SchemaViolation extends Error {}

/**
 * The worker side of meal analysis. The queue calls this once per attempt.
 *
 *  - TransientError (network, 429, 5xx) is rethrown so the queue retries with backoff, until the last attempt.
 *  - Anything else ends the job: the meal is marked failed, or, if it already had values (a failed "Fix Results"),
 *    it goes back to `completed` with the previous values and `errorCode` set.
 */
export function createAnalysisProcessor(deps: WorkerDeps) {
  const { prisma, storage, analyzer, config, logger, clock } = deps;
  const OPEN = ['queued', 'analyzing'] as const;
  const resolver = createDishResolver(prisma, { maxCalories: config.ai.maxCaloriesPerServing, now: clock });

  /**
   * The same photo uploaded again by the same user gets the dishes and portions found the first time,
   * without asking the model (the numbers are recomputed, so a correction made since still applies).
   */
  async function reusedComponents(meal: { id: string; userId: string; imageSha256: string | null }) {
    if (!meal.imageSha256) return null;
    const earlier = await prisma.meal.findFirst({
      where: {
        userId: meal.userId,
        imageSha256: meal.imageSha256,
        id: { not: meal.id },
        status: 'completed',
        components: { some: {} },
      },
      orderBy: { analyzedAt: 'desc' },
      include: { components: { orderBy: { position: 'asc' }, include: { dish: true } } },
    });
    if (!earlier) return null;
    return resolver.compute(
      meal.userId,
      earlier.components.map((c) => ({ dish: c.dish, portion: c.portion })),
    );
  }

  const setStage = (id: string, status: 'analyzing', progress: number) =>
    prisma.meal.updateMany({
      where: { id, deletedAt: null, status: { in: [...OPEN] } },
      data: { status, progress },
    });

  /** One provider call, validated against the strict schema. */
  async function callAndValidate(input: AnalyzerInput): Promise<{ output: AnalyzerOutput; ai: AiMeal }> {
    const output = await analyzer.analyze(input);
    const parsed = aiMealSchema.safeParse(output.raw);
    if (!parsed.success) throw Object.assign(new SchemaViolation('schema violation'), { issues: parsed.error.issues });
    return { output, ai: parsed.data };
  }

  return async function analyzeMeal(mealId: string, attempt: JobAttempt): Promise<void> {
    const meal = await prisma.meal.findFirst({
      where: { id: mealId, deletedAt: null },
      include: { corrections: { orderBy: { createdAt: 'asc' } }, user: { select: { locale: true } } },
    });
    // Redelivered, deleted, or already handled: nothing to do.
    if (!meal || !OPEN.includes(meal.status as (typeof OPEN)[number])) return;

    const locale = meal.user.locale;
    const hadResult = meal.analyzedAt !== null;

    const fail = async (code: MealErrorCode, cause?: unknown) => {
      logger.warn({ mealId, code, err: cause instanceof Error ? cause.message : undefined }, 'meal analysis failed');
      const res = await prisma.meal.updateMany({
        where: { id: mealId, deletedAt: null, status: { in: [...OPEN] } },
        data: hadResult
          ? { status: 'completed', progress: PROGRESS.done, errorCode: code }
          : { status: 'failed', progress: 0, errorCode: code },
      });
      if (res.count) {
        await notifyMeal(deps, meal.userId, locale, 'failed', {
          mealId,
          status: hadResult ? 'completed' : 'failed',
          errorCode: code,
        });
      }
    };

    /** Writes the components and the meal's totals in one transaction, then notifies. */
    const save = async (components: ResolvedComponent[], aiRaw: Record<string, unknown>) => {
      const totals = summarize(components, config.ai.maxCaloriesPerServing);
      const done = await prisma.$transaction(async (tx) => {
        const res = await tx.meal.updateMany({
          where: { id: mealId, deletedAt: null, status: { in: [...OPEN] } },
          data: {
            name: totals.name,
            nameKm: totals.nameKm,
            calories: totals.calories,
            proteinG: totals.proteinG,
            carbsG: totals.carbsG,
            fatG: totals.fatG,
            healthScore: totals.healthScore,
            // Kept for older clients: one item per recognised dish.
            items: components.map((c) => ({
              name: c.dish.nameEn,
              portion: `${c.portion} x ${c.dish.servingDescription}`,
              calories: c.calories,
              proteinG: c.proteinG,
              carbsG: c.carbsG,
              fatG: c.fatG,
            })) as Prisma.InputJsonValue,
            aiRaw: aiRaw as Prisma.InputJsonValue,
            status: 'completed',
            progress: PROGRESS.done,
            errorCode: null,
            analyzedAt: clock(),
          },
        });
        if (!res.count) return 0;
        await tx.mealComponent.deleteMany({ where: { mealId } });
        await tx.mealComponent.createMany({
          data: components.map((c, position) => ({
            mealId,
            dishId: c.dish.id,
            position,
            portion: c.portion,
            calories: c.calories,
            proteinG: c.proteinG,
            carbsG: c.carbsG,
            fatG: c.fatG,
            healthScore: c.healthScore,
            valueSource: c.valueSource,
          })),
        });
        return res.count;
      });
      if (done) await notifyMeal(deps, meal.userId, locale, 'ready', { mealId, status: 'completed' });
    };

    try {
      await setStage(mealId, 'analyzing', PROGRESS.imageReady);

      // A first analysis without a note can reuse an identical earlier photo; a fix or a note always asks the model.
      const reusable = meal.source === 'photo' && !hadResult && !meal.hint && meal.corrections.length === 0;
      const reused = reusable ? await reusedComponents(meal) : null;
      if (reused) {
        await save(reused, { reusedFromHash: meal.imageSha256 });
        return;
      }

      let image: AnalyzerInput['image'];
      if (meal.source === 'photo') {
        if (!meal.imageKey) return await fail('PROVIDER_ERROR', new Error('photo meal has no image'));
        image = { data: await storage.get(meal.imageKey), mimeType: 'image/jpeg' };
      }
      const input: AnalyzerInput = {
        dishes: await resolver.promptEntries(),
        image,
        description: meal.description ?? undefined,
        hint: meal.hint ?? undefined,
        corrections: meal.corrections.map((c) => c.instruction),
        previous: hadResult
          ? { name: meal.name, calories: meal.calories, proteinG: meal.proteinG, carbsG: meal.carbsG, fatG: meal.fatG }
          : undefined,
        locale,
      };

      let result: { output: AnalyzerOutput; ai: AiMeal };
      try {
        try {
          result = await callAndValidate(input);
        } catch (err) {
          if (!(err instanceof SchemaViolation)) throw err;
          // Schema violation: ask once more before giving up.
          logger.info({ mealId }, 'provider returned an invalid shape, retrying once');
          result = await callAndValidate(input);
        }
      } catch (err) {
        if (err instanceof TransientError) {
          if (attempt.attempt < attempt.maxAttempts) throw err; // the queue retries with backoff
          return await fail('PROVIDER_ERROR', err);
        }
        return await fail('PROVIDER_ERROR', err);
      }

      await setStage(mealId, 'analyzing', PROGRESS.modelAnswered);

      const { ai, output } = result;
      if (!ai.isFood) return await fail('NOT_FOOD');
      if (ai.confidence < config.ai.minConfidence) return await fail('LOW_CONFIDENCE');

      if (ai.dishes.length === 0) return await fail('LOW_CONFIDENCE');

      const components = await resolver.resolve(meal.userId, mealId, ai.dishes);
      await setStage(mealId, 'analyzing', PROGRESS.validated);
      await save(components, {
        promptVersion: PROMPT_VERSION,
        provider: output.provider,
        model: output.model,
        response: output.raw,
      });
    } catch (err) {
      // Unexpected failure (database hiccup, storage outage, bug). Retry while attempts remain, then give up cleanly.
      if (attempt.attempt < attempt.maxAttempts) {
        throw err instanceof TransientError ? err : new TransientError('unexpected analysis error', err);
      }
      deps.errorReporter.capture(err, { mealId });
      await fail('PROVIDER_ERROR', err).catch(() => undefined);
    }
  };
}
