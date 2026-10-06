import { z } from 'zod';
import { uuidParam } from '../../lib/dto';
import { authRoute, reply, type RouteDef } from '../../lib/http/route';
import { resolveZone } from '../../lib/time';
import {
  analyzeFieldsSchema,
  barcodeBodySchema,
  createMealBodySchema,
  fixBodySchema,
  listQuerySchema,
  mealEnvelopeSchema,
  mealListSchema,
  patchMealBodySchema,
} from './meals.schemas';
import type { MealsService } from './meals.service';

const TAG = 'Meals';

export function mealsRoutes(svc: MealsService): RouteDef[] {
  return [
    authRoute({
      method: 'post',
      path: '/meals/analyze',
      tags: [TAG],
      summary: 'Upload a food photo for AI analysis',
      description:
        'Used for both camera and gallery photos (`source`). The file type is checked by magic bytes (JPEG, PNG, WebP, HEIC; max 10 MB). The image is resized to 1280 px, stripped of EXIF and stored privately. The meal is created immediately with `status=queued`; poll GET /meals/{id} while it is `queued` or `analyzing`. A push notification is sent on completion. Send an `Idempotency-Key` header to make retries safe.',
      limiter: 'analyze',
      multipart: { fileField: 'image', fileDescription: 'JPEG, PNG, WebP or HEIC photo, up to 10 MB' },
      body: analyzeFieldsSchema,
      responses: {
        202: { description: 'Accepted. The meal is queued.', schema: mealEnvelopeSchema },
        413: { description: 'FILE_TOO_LARGE' },
        415: { description: 'UNSUPPORTED_MEDIA_TYPE' },
        422: { description: 'INVALID_IMAGE' },
        503: { description: 'QUEUE_UNAVAILABLE' },
      },
      handler: async ({ req, user, body, file }) => {
        const key = req.header('idempotency-key')?.trim();
        const meal = await svc.analyzeImage(user, { file, ...body, idempotencyKey: key || undefined });
        return reply(202, { meal });
      },
    }),

    authRoute({
      method: 'post',
      path: '/meals/barcode',
      tags: [TAG],
      summary: 'Log a packaged product by barcode',
      description:
        'Looks the barcode up in Open Food Facts (cached) and creates a completed meal from the per-serving data. Answers 404 PRODUCT_NOT_FOUND so the client can fall back to manual entry.',
      body: barcodeBodySchema,
      responses: {
        201: { description: 'Meal created', schema: mealEnvelopeSchema },
        404: { description: 'PRODUCT_NOT_FOUND' },
        502: { description: 'PRODUCT_LOOKUP_UNAVAILABLE' },
      },
      handler: async ({ user, body }) => ({ meal: await svc.fromBarcode(user, body) }),
    }),

    authRoute({
      method: 'post',
      path: '/meals',
      tags: [TAG],
      summary: 'Manual entry, or a text description for an AI estimate',
      description:
        'With `name`, `calories`, `proteinG`, `carbsG` and `fatG` the meal is created as completed (201). With only `description` an AI estimate is queued (202), exactly like a photo.',
      body: createMealBodySchema,
      responses: {
        201: { description: 'Manual meal created', schema: mealEnvelopeSchema },
        202: { description: 'Text estimate queued', schema: mealEnvelopeSchema },
      },
      handler: async ({ user, body }) => {
        if (body.description !== undefined) {
          return reply(202, { meal: await svc.createFromText(user, { description: body.description, loggedAt: body.loggedAt }) });
        }
        // The schema guarantees these are present when description is absent.
        const m = body as Required<Pick<typeof body, 'name' | 'calories' | 'proteinG' | 'carbsG' | 'fatG'>> & typeof body;
        return reply(201, { meal: await svc.createManual(user, m) });
      },
    }),

    authRoute({
      method: 'get',
      path: '/meals',
      tags: [TAG],
      summary: 'List meals, newest first',
      description:
        'With `date` (YYYY-MM-DD, `today` or `yesterday`) returns that calendar day in the user\'s timezone, or in the `X-Timezone` header when sent. Paginate with `cursor`.',
      query: listQuerySchema,
      responses: {
        200: {
          description: 'A page of meals',
          schema: mealListSchema.extend({ date: z.string().nullable() }),
        },
      },
      handler: async ({ req, user, query }) =>
        svc.list(user, resolveZone(req.header('x-timezone'), user.timezone), query),
    }),

    authRoute({
      method: 'get',
      path: '/meals/:id',
      tags: [TAG],
      summary: 'Meal detail for the Nutrition screen',
      description: 'Includes signed image URLs (15 minute expiry), per-serving values, totals, health score and analysis progress.',
      params: uuidParam,
      responses: { 200: { description: 'The meal', schema: mealEnvelopeSchema }, 404: { description: 'MEAL_NOT_FOUND' } },
      handler: async ({ user, params }) => ({ meal: await svc.get(user, params.id) }),
    }),

    authRoute({
      method: 'patch',
      path: '/meals/:id',
      tags: [TAG],
      summary: 'Edit a meal',
      description:
        'Calories and macros are per serving; `quantity` (0.25 to 20) scales them and totals are computed on read. A meal that failed analysis becomes completed when all four nutrition values are supplied.',
      params: uuidParam,
      body: patchMealBodySchema,
      responses: {
        200: { description: 'Updated meal', schema: mealEnvelopeSchema },
        404: { description: 'MEAL_NOT_FOUND' },
        409: { description: 'MEAL_BUSY' },
        422: { description: 'MANUAL_VALUES_INCOMPLETE' },
      },
      handler: async ({ user, params, body }) => ({ meal: await svc.patch(user, params.id, body) }),
    }),

    authRoute({
      method: 'post',
      path: '/meals/:id/fix',
      tags: [TAG],
      summary: 'Fix Results: re-analyze with a correction',
      description:
        'Saves the instruction (for example "that was chicken, not turkey, and no chips") and re-queues analysis with the original image plus every correction so far. The previous values stay in place until the new result completes.',
      params: uuidParam,
      body: fixBodySchema,
      responses: {
        202: { description: 'Re-analysis queued', schema: mealEnvelopeSchema },
        404: { description: 'MEAL_NOT_FOUND' },
        409: { description: 'MEAL_BUSY' },
        422: { description: 'FIX_NOT_SUPPORTED (barcode and manual meals have nothing to re-analyze)' },
      },
      handler: async ({ user, params, body }) => reply(202, { meal: await svc.fix(user, params.id, body.instruction) }),
    }),

    authRoute({
      method: 'delete',
      path: '/meals/:id',
      tags: [TAG],
      summary: 'Delete a meal',
      description: 'Soft delete. Deleted meals disappear from lists and daily totals.',
      params: uuidParam,
      responses: { 204: { description: 'Deleted' }, 404: { description: 'MEAL_NOT_FOUND' } },
      handler: async ({ user, params }) => {
        await svc.remove(user, params.id);
        return reply(204);
      },
    }),
  ];
}
