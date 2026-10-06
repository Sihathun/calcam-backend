import { beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, onboardingPayload, registerUser, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(() => {
  ctx = createTestContext();
});
const api = '/api/v1';

describe('GET /me and PATCH /me/preferences', () => {
  it('returns user + profile + active goal', async () => {
    const user = await registerUser(ctx);
    const res = await ctx.http.get(`${api}/me`).set(user.auth);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(user.email);
    expect(res.body.profile.birthDate).toBe('2001-01-01');
    expect(res.body.goal).toHaveProperty('calories');
  });

  it('updates language, timezone, units and notifications', async () => {
    const user = await registerUser(ctx);
    const res = await ctx.http
      .patch(`${api}/me/preferences`)
      .set(user.auth)
      .send({ locale: 'es', timezone: 'America/Los_Angeles', weightUnitPref: 'lbs', heightUnitPref: 'cm', notificationsEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ locale: 'es', timezone: 'America/Los_Angeles', notificationsEnabled: false });
    expect(res.body.profile).toMatchObject({ weightUnitPref: 'lbs', heightUnitPref: 'cm' });
    // Units are display-only: the stored weight is still metric.
    expect(res.body.profile.weightKg).toBe(54);
  });

  it('validates timezone and requires at least one field', async () => {
    const user = await registerUser(ctx);
    const bad = await ctx.http.patch(`${api}/me/preferences`).set(user.auth).send({ timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('timezone');
    expect((await ctx.http.patch(`${api}/me/preferences`).set(user.auth).send({})).status).toBe(400);
  });

  it('needs onboarding before unit preferences can be stored', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const res = await ctx.http.patch(`${api}/me/preferences`).set(user.auth).send({ weightUnitPref: 'lbs' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ONBOARDING_REQUIRED');
    // Language does not.
    expect((await ctx.http.patch(`${api}/me/preferences`).set(user.auth).send({ locale: 'es' })).status).toBe(200);
  });
});

describe('PATCH /me/profile', () => {
  it('offers a recalculation when plan inputs change, without applying it', async () => {
    const user = await registerUser(ctx);
    const before = (await ctx.http.get(`${api}/me/goals`).set(user.auth)).body;

    const res = await ctx.http.patch(`${api}/me/profile`).set(user.auth).send({ workoutsPerWeek: '6+' });
    expect(res.status).toBe(200);
    expect(res.body.profile.workoutsPerWeek).toBe('6+');
    expect(res.body.profile.activityLevel).toBe('active');
    expect(res.body.recalculation.suggested).toBe(true);
    expect(res.body.recalculation.plan.plan.calories).toBeGreaterThan(before.calories);

    // Nothing changed until the client asks for it.
    expect((await ctx.http.get(`${api}/me/goals`).set(user.auth)).body.id).toBe(before.id);
  });

  it('does not offer a recalculation for non-plan fields', async () => {
    const user = await registerUser(ctx);
    const res = await ctx.http.patch(`${api}/me/profile`).set(user.auth).send({ accomplishment: 'stay_motivated', referralSource: 'google' });
    expect(res.body.recalculation.suggested).toBe(false);
    expect(res.body.profile.accomplishment).toBe('stay_motivated');
  });

  it('logs a new weight when weightKg is sent and offers a recalculation after a big change', async () => {
    const user = await registerUser(ctx);
    const res = await ctx.http.patch(`${api}/me/profile`).set(user.auth).send({ weightKg: 58.4 });
    expect(res.body.profile.weightKg).toBe(58.4);
    expect(res.body.recalculation.suggested).toBe(true);
    const logs = await ctx.http.get(`${api}/me/weight-logs`).set(user.auth);
    expect(logs.body.items.map((i: any) => i.weightKg)).toEqual([54, 58.4]);
  });

  it('refuses a goal that is not advisable and saves nothing', async () => {
    const user = await registerUser(ctx, { onboarding: onboardingPayload({ weightKg: 45 }) });
    const res = await ctx.http.patch(`${api}/me/profile`).set(user.auth).send({ goal: 'lose' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GOAL_NOT_SUPPORTED');
    const me = await ctx.http.get(`${api}/me`).set(user.auth);
    expect(me.body.profile.goal).toBe('maintain');
  });

  it('stores a target weight for lose/gain and clears it when switching to maintain', async () => {
    const user = await registerUser(ctx, { onboarding: onboardingPayload({ weightKg: 70 }) });
    const lose = await ctx.http.patch(`${api}/me/profile`).set(user.auth).send({ goal: 'lose', targetWeightKg: 62 });
    expect(lose.status).toBe(200);
    expect(lose.body.profile).toMatchObject({ goal: 'lose', targetWeightKg: 62 });
    const wrongWay = await ctx.http.patch(`${api}/me/profile`).set(user.auth).send({ targetWeightKg: 80 });
    expect(wrongWay.status).toBe(422);
    expect(wrongWay.body.error.code).toBe('INVALID_TARGET_WEIGHT');
    const back = await ctx.http.patch(`${api}/me/profile`).set(user.auth).send({ goal: 'maintain' });
    expect(back.body.profile.targetWeightKg).toBe(70); // maintain = current weight
  });

  it('is 409 before onboarding and 400 for an empty body', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    expect((await ctx.http.patch(`${api}/me/profile`).set(user.auth).send({ diet: 'keto' })).status).toBe(409);
    const full = await registerUser(ctx);
    expect((await ctx.http.patch(`${api}/me/profile`).set(full.auth).send({})).status).toBe(400);
  });
});

describe('goals', () => {
  it('GET /me/goals returns the active goal, 404 before onboarding', async () => {
    const user = await registerUser(ctx);
    const res = await ctx.http.get(`${api}/me/goals`).set(user.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'calculated' });
    const none = await registerUser(ctx, { onboarding: false });
    const missing = await ctx.http.get(`${api}/me/goals`).set(none.auth);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NO_ACTIVE_GOAL');
  });

  it('PUT merges partial edits into a new user_edited version and keeps history', async () => {
    const user = await registerUser(ctx);
    const original = (await ctx.http.get(`${api}/me/goals`).set(user.auth)).body;
    const res = await ctx.http.put(`${api}/me/goals`).set(user.auth).send({ calories: 2000, proteinG: 120 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ calories: 2000, proteinG: 120, carbsG: original.carbsG, fatG: original.fatG, source: 'user_edited' });
    expect(res.body.id).not.toBe(original.id);
    expect(await ctx.deps.prisma.nutritionGoal.count({ where: { userId: user.id } })).toBe(2);
    expect((await ctx.http.get(`${api}/me/goals`).set(user.auth)).body.calories).toBe(2000);
  });

  it('clamps calories to 800-6000 and macros to non-negative', async () => {
    const user = await registerUser(ctx);
    const low = await ctx.http.put(`${api}/me/goals`).set(user.auth).send({ calories: 100, fatG: -5 });
    expect(low.body).toMatchObject({ calories: 800, fatG: 0 });
    const high = await ctx.http.put(`${api}/me/goals`).set(user.auth).send({ calories: 99999 });
    expect(high.body.calories).toBe(6000);
    expect((await ctx.http.put(`${api}/me/goals`).set(user.auth).send({})).status).toBe(400);
  });

  it('POST /me/goals/recalculate re-runs the engine from the profile and latest weight', async () => {
    const user = await registerUser(ctx);
    await ctx.http.put(`${api}/me/goals`).set(user.auth).send({ calories: 5000 });
    await ctx.http.post(`${api}/me/weight-logs`).set(user.auth).send({ weightKg: 60 });
    const res = await ctx.http.post(`${api}/me/goals/recalculate`).set(user.auth);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('calculated');
    expect(res.body.calories).toBeLessThan(2500);
    const preview = await ctx.http.post(`${api}/onboarding/plan-preview`).send({
      sex: 'female', birthDate: '2001-01-01', heightCm: 167.6, weightKg: 60, workoutsPerWeek: '0-2', goal: 'maintain', diet: 'balanced',
    });
    expect(res.body.calories).toBe(preview.body.plan.calories);
  });

  it('recalculate needs onboarding', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    expect((await ctx.http.post(`${api}/me/goals/recalculate`).set(user.auth)).status).toBe(409);
  });
});

describe('weight logs', () => {
  it('logs, lists oldest first within a range, and deletes', async () => {
    const user = await registerUser(ctx);
    const a = await ctx.http.post(`${api}/me/weight-logs`).set(user.auth).send({ weightKg: 53.84, loggedAt: '2026-01-01T08:00:00Z' });
    expect(a.status).toBe(201);
    expect(a.body.weightLog.weightKg).toBe(53.8); // 0.1 kg precision
    await ctx.http.post(`${api}/me/weight-logs`).set(user.auth).send({ weightKg: 53.1, loggedAt: '2026-02-01T08:00:00Z' });

    const all = await ctx.http.get(`${api}/me/weight-logs`).set(user.auth);
    expect(all.body.items.map((i: any) => i.weightKg)).toEqual([53.8, 53.1, 54]);
    const ranged = await ctx.http.get(`${api}/me/weight-logs`).set(user.auth).query({ from: '2026-01-15T00:00:00Z', to: '2026-02-15T00:00:00Z' });
    expect(ranged.body.items.map((i: any) => i.weightKg)).toEqual([53.1]);

    expect((await ctx.http.delete(`${api}/me/weight-logs/${a.body.weightLog.id}`).set(user.auth)).status).toBe(204);
    expect((await ctx.http.delete(`${api}/me/weight-logs/${a.body.weightLog.id}`).set(user.auth)).status).toBe(404);
  });

  it('validates weight and refuses future dates', async () => {
    const user = await registerUser(ctx);
    expect((await ctx.http.post(`${api}/me/weight-logs`).set(user.auth).send({ weightKg: 5 })).status).toBe(400);
    const future = await ctx.http.post(`${api}/me/weight-logs`).set(user.auth).send({ weightKg: 55, loggedAt: '2099-01-01T00:00:00Z' });
    expect(future.status).toBe(400);
  });

  it('reports a recalculation offer, or why none is possible', async () => {
    const user = await registerUser(ctx, { onboarding: onboardingPayload({ weightKg: 60, goal: 'lose', targetWeightKg: 55 }) });
    const small = await ctx.http.post(`${api}/me/weight-logs`).set(user.auth).send({ weightKg: 59.8 });
    expect(small.body.recalculation.suggested).toBe(false);
    const big = await ctx.http.post(`${api}/me/weight-logs`).set(user.auth).send({ weightKg: 58.5 });
    expect(big.body.recalculation.suggested).toBe(true);
    // Weight drops under BMI 18.5 for a "lose" goal: no plan can be offered.
    const tooLow = await ctx.http.post(`${api}/me/weight-logs`).set(user.auth).send({ weightKg: 50 });
    expect(tooLow.body.recalculation).toEqual({ suggested: false, reason: 'GOAL_NOT_SUPPORTED', plan: null });
  });
});

describe('devices', () => {
  it('registers idempotently and moves a token to the user who signs in on the device', async () => {
    const a = await registerUser(ctx);
    const b = await registerUser(ctx);
    const token = `fcm-${Date.now()}-${'x'.repeat(30)}`;
    expect((await ctx.http.post(`${api}/me/devices`).set(a.auth).send({ token, platform: 'android' })).status).toBe(200);
    expect((await ctx.http.post(`${api}/me/devices`).set(a.auth).send({ token, platform: 'android' })).status).toBe(200);
    expect(await ctx.deps.prisma.deviceToken.count({ where: { token } })).toBe(1);

    await ctx.http.post(`${api}/me/devices`).set(b.auth).send({ token, platform: 'ios' });
    const row = await ctx.deps.prisma.deviceToken.findUniqueOrThrow({ where: { token } });
    expect(row.userId).toBe(b.id);
    expect(row.platform).toBe('ios');
  });

  it('unregisters only the caller\'s own token', async () => {
    const a = await registerUser(ctx);
    const b = await registerUser(ctx);
    const token = `fcm-own-${Date.now()}-${'y'.repeat(30)}`;
    await ctx.http.post(`${api}/me/devices`).set(a.auth).send({ token, platform: 'ios' });
    expect((await ctx.http.delete(`${api}/me/devices/${token}`).set(b.auth)).status).toBe(204);
    expect(await ctx.deps.prisma.deviceToken.count({ where: { token } })).toBe(1);
    expect((await ctx.http.delete(`${api}/me/devices/${token}`).set(a.auth)).status).toBe(204);
    expect(await ctx.deps.prisma.deviceToken.count({ where: { token } })).toBe(0);
  });

  it('validates platform', async () => {
    const a = await registerUser(ctx);
    expect((await ctx.http.post(`${api}/me/devices`).set(a.auth).send({ token: 'z'.repeat(30), platform: 'windows' })).status).toBe(400);
  });
});
