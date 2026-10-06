import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeMeal, createTestContext, registerUser, type TestContext, type TestUser } from './helpers';

let ctx: TestContext;
let a: TestUser;
let b: TestUser;
beforeAll(async () => {
  ctx = createTestContext();
  a = await registerUser(ctx);
  b = await registerUser(ctx);
});
const api = '/api/v1';

describe('every query is scoped to the signed-in user (other users\' resources are 404, not 403)', () => {
  it('meals', async () => {
    const meal = await analyzeMeal(ctx, a);
    const id = meal['id'];
    expect((await ctx.http.get(`${api}/meals/${id}`).set(a.auth)).status).toBe(200);

    expect((await ctx.http.get(`${api}/meals/${id}`).set(b.auth)).status).toBe(404);
    expect((await ctx.http.patch(`${api}/meals/${id}`).set(b.auth).send({ name: 'stolen' })).status).toBe(404);
    expect((await ctx.http.post(`${api}/meals/${id}/fix`).set(b.auth).send({ instruction: 'hijack' })).status).toBe(404);
    expect((await ctx.http.delete(`${api}/meals/${id}`).set(b.auth)).status).toBe(404);

    // Nothing leaked into B's lists or dashboard, and nothing of A's changed.
    expect((await ctx.http.get(`${api}/meals`).set(b.auth)).body.items).toHaveLength(0);
    expect((await ctx.http.get(`${api}/dashboard/daily`).set(b.auth)).body.meals).toHaveLength(0);
    const after = (await ctx.http.get(`${api}/meals/${id}`).set(a.auth)).body.meal;
    expect(after.name).toBe('Turkey Sandwich With Potato Chips');
    expect(after.status).toBe('completed');
    expect(await ctx.deps.prisma.mealCorrection.count({ where: { mealId: id } })).toBe(0);
  });

  it('weight logs', async () => {
    const log = await ctx.http.post(`${api}/me/weight-logs`).set(a.auth).send({ weightKg: 55 });
    const id = log.body.weightLog.id;
    expect((await ctx.http.delete(`${api}/me/weight-logs/${id}`).set(b.auth)).status).toBe(404);
    expect(await ctx.deps.prisma.weightLog.count({ where: { id } })).toBe(1);
    const bLogs = (await ctx.http.get(`${api}/me/weight-logs`).set(b.auth)).body.items;
    expect(bLogs.every((l: any) => l.id !== id)).toBe(true);
  });

  it('goals and profile always describe the caller', async () => {
    await ctx.http.put(`${api}/me/goals`).set(a.auth).send({ calories: 3333 });
    expect((await ctx.http.get(`${api}/me/goals`).set(b.auth)).body.calories).not.toBe(3333);
    expect((await ctx.http.get(`${api}/me`).set(b.auth)).body.id).toBe(b.id);
  });

  it('a token cannot be used for a user that was deleted', async () => {
    const c = await registerUser(ctx);
    await ctx.http.delete(`${api}/me`).set(c.auth);
    await ctx.queue.drain();
    expect((await ctx.http.get(`${api}/me`).set(c.auth)).status).toBe(401);
  });
});

describe('OpenAPI document', () => {
  // Every endpoint named in the product spec, with its method.
  const REQUIRED: [string, string][] = [
    ['post', '/api/v1/auth/register'], ['post', '/api/v1/auth/login'], ['post', '/api/v1/auth/oauth/apple'],
    ['post', '/api/v1/auth/oauth/google'], ['post', '/api/v1/auth/refresh'], ['post', '/api/v1/auth/logout'],
    ['post', '/api/v1/auth/password/forgot'], ['post', '/api/v1/auth/password/reset'], ['delete', '/api/v1/me'],
    ['get', '/api/v1/onboarding/options'], ['post', '/api/v1/onboarding/plan-preview'], ['post', '/api/v1/onboarding/complete'],
    ['get', '/api/v1/me'], ['patch', '/api/v1/me/profile'], ['patch', '/api/v1/me/preferences'],
    ['get', '/api/v1/me/goals'], ['put', '/api/v1/me/goals'], ['post', '/api/v1/me/goals/recalculate'],
    ['post', '/api/v1/me/weight-logs'], ['get', '/api/v1/me/weight-logs'], ['delete', '/api/v1/me/weight-logs/{id}'],
    ['post', '/api/v1/me/devices'], ['delete', '/api/v1/me/devices/{token}'],
    ['post', '/api/v1/meals/analyze'], ['post', '/api/v1/meals/barcode'], ['post', '/api/v1/meals'],
    ['get', '/api/v1/meals/{id}'], ['get', '/api/v1/meals'], ['patch', '/api/v1/meals/{id}'],
    ['post', '/api/v1/meals/{id}/fix'], ['delete', '/api/v1/meals/{id}'],
    ['get', '/api/v1/dashboard/daily'], ['get', '/api/v1/analytics/summary'],
    ['get', '/health'], ['get', '/ready'],
  ];

  it('is OpenAPI 3.1 and documents every endpoint in the product spec', async () => {
    const res = await ctx.http.get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    const missing = REQUIRED.filter(([method, path]) => !res.body.paths[path]?.[method]);
    expect(missing).toEqual([]);
  });

  it('describes the multipart upload, the bearer scheme and the error shape', async () => {
    const doc = (await ctx.http.get('/openapi.json')).body;
    const analyze = doc.paths['/api/v1/meals/analyze'].post;
    expect(analyze.requestBody.content['multipart/form-data'].schema.properties.image).toMatchObject({ type: 'string', format: 'binary' });
    expect(analyze.requestBody.content['multipart/form-data'].schema.required).toContain('image');
    expect(analyze.responses['202']).toBeDefined();
    expect(analyze.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/api/v1/auth/login'].post.security).toEqual([]);
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    expect(doc.paths['/api/v1/meals/{id}'].get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(doc.paths['/api/v1/meals/{id}'].get.responses['404'].content['application/json'].schema.$ref).toBe('#/components/schemas/ErrorResponse');
  });

  it('matches the implementation: every route that is documented as authenticated rejects anonymous calls', async () => {
    const doc = (await ctx.http.get('/openapi.json')).body;
    const sample = '6f1c0d52-5d1e-4c8e-9a43-0e0a6d3d9b11';
    let checked = 0;
    for (const [path, ops] of Object.entries<any>(doc.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        if (!op.security?.length) continue;
        const url = path.replace('{id}', sample).replace('{token}', 'abc');
        const res = await (ctx.http as any)[method](url).send({});
        expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
        checked += 1;
      }
    }
    // 23 authenticated operations: me (4), onboarding/complete, goals (3), weight (3), devices (2), meals (8), dashboard, analytics.
    expect(checked).toBe(23);
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await ctx.http.get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});

describe('ops endpoints', () => {
  it('/health is liveness only', async () => {
    const res = await ctx.http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('/ready checks the dependencies, and goes 503 when one is down', async () => {
    const ok = await ctx.http.get('/ready');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ready', checks: { database: 'ok', storage: 'ok' } });

    const original = ctx.deps.probes[1]!.check;
    ctx.deps.probes[1]!.check = async () => {
      throw new Error('S3 unreachable');
    };
    try {
      const down = await ctx.http.get('/ready');
      expect(down.status).toBe(503);
      expect(down.body).toEqual({ status: 'unavailable', checks: { database: 'ok', storage: 'fail' } });
    } finally {
      ctx.deps.probes[1]!.check = original;
    }
  });

  it('sets security headers and no X-Powered-By', async () => {
    const res = await ctx.http.get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('CORS is an allowlist from the environment', async () => {
    const strict = createTestContext({ env: { CORS_ORIGINS: 'https://app.example.com' } });
    const allowed = await strict.http.get('/health').set('Origin', 'https://app.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const denied = await strict.http.get('/health').set('Origin', 'https://evil.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const none = await ctx.http.get('/health').set('Origin', 'https://app.example.com');
    expect(none.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('/metrics exists only when enabled', async () => {
    expect((await ctx.http.get('/metrics')).status).toBe(404);
    const on = createTestContext({ env: { METRICS_ENABLED: 'true' } });
    await on.http.get('/health');
    const res = await on.http.get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_request_duration_seconds');
    expect(res.text).toContain('route="/health"');
  });
});
