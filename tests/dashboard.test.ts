import { describe, expect, it } from 'vitest';
import {
  analyzeMeal,
  createTestContext,
  onboardingPayload,
  registerUser,
  uploadMeal,
  type TestContext,
  type TestUser,
} from './helpers';

const api = '/api/v1';
const MOCK_GOAL = { calories: 2199, proteinG: 161, carbsG: 251, fatG: 61 };

const daily = (ctx: TestContext, u: TestUser, query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  ctx.http.get(`${api}/dashboard/daily`).set(u.auth).set(headers).query(query);

const manual = (ctx: TestContext, u: TestUser, over: Record<string, unknown>) =>
  ctx.http.post(`${api}/meals`).set(u.auth).send({ name: 'Meal', calories: 100, proteinG: 5, carbsG: 10, fatG: 2, ...over });

describe('GET /dashboard/daily: the Home screen', () => {
  it('reproduces the mock-up: 2199 - 460 = 1739, 161 - 25 = 136, 251 - 45 = 206, 61 - 20 = 41', async () => {
    // 2:10 PM in Phnom Penh, the time shown on the mock-up.
    const ctx = createTestContext({ now: new Date('2026-10-06T07:10:00Z') });
    const u = await registerUser(ctx, { onboarding: onboardingPayload({ acceptedGoal: MOCK_GOAL }) });
    await analyzeMeal(ctx, u);

    const res = await daily(ctx, u);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      date: '2026-10-06',
      timezone: 'Asia/Phnom_Penh',
      goal: MOCK_GOAL,
      consumed: { calories: 460, proteinG: 25, carbsG: 45, fatG: 20 },
      remaining: { calories: 1739, proteinG: 136, carbsG: 206, fatG: 41 },
    });
    expect(res.body.meals).toHaveLength(1);
    expect(res.body.meals[0]).toMatchObject({
      name: 'Turkey Sandwich, Potato Chips',
      status: 'completed',
      progress: 100,
      calories: 460,
      proteinG: 25,
      carbsG: 45,
      fatG: 20,
      loggedAt: '2026-10-06T07:10:00.000Z',
    });
    expect(res.body.meals[0].thumbnailUrl).toBeTruthy();
  });

  it('lists a meal that is still analyzing but does not count it (the "Analyzing food..." card)', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-06T07:10:00Z') });
    const u = await registerUser(ctx, { onboarding: onboardingPayload({ acceptedGoal: MOCK_GOAL }) });
    ctx.queue.paused = true;
    await uploadMeal(ctx, u);

    const res = await daily(ctx, u);
    // The mock-up shows the full goal left (2199 / 161 / 251 / 61) while the meal is analyzing.
    expect(res.body.remaining).toEqual(MOCK_GOAL);
    expect(res.body.consumed).toEqual({ calories: 0, proteinG: 0, carbsG: 0, fatG: 0 });
    expect(res.body.meals).toHaveLength(1);
    expect(res.body.meals[0]).toMatchObject({ name: null, status: 'queued', progress: 5, calories: null });
    expect(res.body.meals[0].thumbnailUrl).toBeTruthy();
  });

  it('does not count failed or deleted meals, and multiplies by quantity', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-06T07:10:00Z') });
    const u = await registerUser(ctx, { onboarding: onboardingPayload({ acceptedGoal: MOCK_GOAL }) });
    await analyzeMeal(ctx, u, { hint: 'notfood' });
    const deleted = await manual(ctx, u, { calories: 700 });
    await ctx.http.delete(`${api}/meals/${deleted.body.meal.id}`).set(u.auth);
    await manual(ctx, u, { calories: 200, proteinG: 10, carbsG: 20, fatG: 4, quantity: 2 });

    const res = await daily(ctx, u);
    expect(res.body.consumed).toEqual({ calories: 400, proteinG: 20, carbsG: 40, fatG: 8 });
    expect(res.body.meals.map((m: any) => m.status).sort()).toEqual(['completed', 'failed']);
  });

  it('keeps counting the previous values while "Fix Results" re-analyzes', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-06T07:10:00Z') });
    const u = await registerUser(ctx);
    const meal = await analyzeMeal(ctx, u);
    ctx.queue.paused = true;
    await ctx.http.post(`${api}/meals/${meal['id']}/fix`).set(u.auth).send({ instruction: 'it was chicken' });
    const res = await daily(ctx, u);
    expect(res.body.consumed.calories).toBe(460);
    expect(res.body.meals[0]).toMatchObject({ status: 'queued', calories: 460 });
  });

  it('lets remaining go negative', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-06T07:10:00Z') });
    const u = await registerUser(ctx, { onboarding: onboardingPayload({ acceptedGoal: MOCK_GOAL }) });
    await manual(ctx, u, { calories: 2500, proteinG: 170.5, carbsG: 10, fatG: 10 });
    const res = await daily(ctx, u);
    expect(res.body.remaining).toEqual({ calories: -301, proteinG: -9.5, carbsG: 241, fatG: 51 });
  });

  it('is empty for a day with no meals, and 409 before onboarding', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-06T07:10:00Z') });
    const u = await registerUser(ctx);
    const res = await daily(ctx, u, { date: '2026-01-01' });
    expect(res.body.meals).toEqual([]);
    expect(res.body.consumed.calories).toBe(0);
    const bare = await registerUser(ctx, { onboarding: false });
    expect((await daily(ctx, bare)).status).toBe(409);
  });

  it('validates the date', async () => {
    const ctx = createTestContext();
    const u = await registerUser(ctx);
    expect((await daily(ctx, u, { date: '2026-02-30' })).status).toBe(400);
    expect((await daily(ctx, u, { date: 'tomorrow' })).status).toBe(400);
  });
});

describe('Today / Yesterday and the user\'s timezone', () => {
  // 2026-10-06T17:30:00Z is just after midnight in Phnom Penh (Oct 7, 00:30) and still the morning in Los Angeles (Oct 6, 10:30).
  const NOW = new Date('2026-10-06T17:30:00Z');

  it('Asia/Phnom_Penh (UTC+7): a meal at 23:59 belongs to yesterday, one at 00:01 to today', async () => {
    const ctx = createTestContext({ now: NOW });
    const u = await registerUser(ctx); // stored timezone: Asia/Phnom_Penh
    await manual(ctx, u, { name: 'Late dinner', loggedAt: '2026-10-06T16:59:00Z' }); // 23:59 on Oct 6
    await manual(ctx, u, { name: 'Midnight snack', loggedAt: '2026-10-06T17:01:00Z' }); // 00:01 on Oct 7

    const today = await daily(ctx, u, { date: 'today' });
    expect(today.body.date).toBe('2026-10-07');
    expect(today.body.meals.map((m: any) => m.name)).toEqual(['Midnight snack']);
    const yesterday = await daily(ctx, u, { date: 'yesterday' });
    expect(yesterday.body.date).toBe('2026-10-06');
    expect(yesterday.body.meals.map((m: any) => m.name)).toEqual(['Late dinner']);
    // Default is today.
    expect((await daily(ctx, u)).body.date).toBe('2026-10-07');
  });

  it('boundaries are exact: local midnight is the new day, one millisecond earlier is the old one', async () => {
    const ctx = createTestContext({ now: NOW });
    const u = await registerUser(ctx);
    await manual(ctx, u, { name: 'Before', loggedAt: '2026-10-06T16:59:59.999Z' });
    await manual(ctx, u, { name: 'At midnight', loggedAt: '2026-10-06T17:00:00.000Z' });
    expect((await daily(ctx, u, { date: '2026-10-07' })).body.meals.map((m: any) => m.name)).toEqual(['At midnight']);
    expect((await daily(ctx, u, { date: '2026-10-06' })).body.meals.map((m: any) => m.name)).toEqual(['Before']);
  });

  it('America/Los_Angeles: the same instants fall on the same calendar day', async () => {
    const ctx = createTestContext({ now: NOW });
    const u = await registerUser(ctx, { onboarding: onboardingPayload({ timezone: 'America/Los_Angeles' }) });
    await manual(ctx, u, { name: 'Late dinner', loggedAt: '2026-10-06T16:59:00Z' }); // 09:59 PDT
    await manual(ctx, u, { name: 'Midnight snack', loggedAt: '2026-10-06T17:01:00Z' }); // 10:01 PDT

    const today = await daily(ctx, u);
    expect(today.body.date).toBe('2026-10-06');
    expect(today.body.meals.map((m: any) => m.name).sort()).toEqual(['Late dinner', 'Midnight snack']);
    expect((await daily(ctx, u, { date: 'yesterday' })).body.meals).toHaveLength(0);

    // 06:59:59.999Z is 23:59:59.999 PDT on Oct 6... and 07:00:00Z is midnight Oct 7.
    await manual(ctx, u, { name: 'Last ms', loggedAt: '2026-10-07T06:59:59.999Z' });
    await manual(ctx, u, { name: 'First ms', loggedAt: '2026-10-07T07:00:00.000Z' });
    expect((await daily(ctx, u, { date: '2026-10-07' })).body.meals.map((m: any) => m.name)).toEqual(['First ms']);
    expect((await daily(ctx, u, { date: '2026-10-06' })).body.meals.map((m: any) => m.name)).toContain('Last ms');
  });

  it('the X-Timezone header overrides the stored timezone (a traveller)', async () => {
    const ctx = createTestContext({ now: NOW });
    const u = await registerUser(ctx); // Phnom Penh
    expect((await daily(ctx, u)).body.date).toBe('2026-10-07');
    const la = await daily(ctx, u, {}, { 'X-Timezone': 'America/Los_Angeles' });
    expect(la.body).toMatchObject({ date: '2026-10-06', timezone: 'America/Los_Angeles' });
    const bad = await daily(ctx, u, {}, { 'X-Timezone': 'Not/AZone' });
    expect(bad.body.timezone).toBe('Asia/Phnom_Penh'); // an invalid header is ignored
  });

  it('handles the 25-hour day when daylight saving ends (Los Angeles, 2026-11-01)', async () => {
    const ctx = createTestContext({ now: new Date('2026-11-02T20:00:00Z') });
    const u = await registerUser(ctx, { onboarding: onboardingPayload({ timezone: 'America/Los_Angeles' }) });
    await manual(ctx, u, { name: 'Nov 1 early', loggedAt: '2026-11-01T07:30:00Z' }); // 00:30 PDT
    await manual(ctx, u, { name: 'Nov 1 late', loggedAt: '2026-11-02T07:59:00Z' }); // 23:59 PST (UTC-8 after the change)
    await manual(ctx, u, { name: 'Nov 2', loggedAt: '2026-11-02T08:01:00Z' }); // 00:01 PST
    expect((await daily(ctx, u, { date: '2026-11-01' })).body.meals.map((m: any) => m.name).sort()).toEqual(['Nov 1 early', 'Nov 1 late']);
    expect((await daily(ctx, u, { date: '2026-11-02' })).body.meals.map((m: any) => m.name)).toEqual(['Nov 2']);
  });
});

describe('the goal that was active on that day', () => {
  it('editing the goal later never rewrites an earlier day', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-01T05:00:00Z') });
    const u = await registerUser(ctx, { onboarding: onboardingPayload({ acceptedGoal: MOCK_GOAL }) });

    ctx.setNow(new Date('2026-10-05T05:00:00Z'));
    await ctx.http.put(`${api}/me/goals`).set(u.auth).send({ calories: 1800 });

    const before = await daily(ctx, u, { date: '2026-10-03' });
    expect(before.body.goal.calories).toBe(2199);
    expect(before.body.remaining.calories).toBe(2199);
    const onTheDay = await daily(ctx, u, { date: '2026-10-05' });
    expect(onTheDay.body.goal.calories).toBe(1800);
    expect((await daily(ctx, u, { date: '2026-10-09' })).body.goal.calories).toBe(1800);
    // Before the account existed the first goal is used rather than failing.
    expect((await daily(ctx, u, { date: '2026-09-01' })).body.goal.calories).toBe(2199);
  });
});

describe('analytics', () => {
  it('summarises calories vs goal per day, averages, streak, weight and health score', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-01T05:00:00Z') });
    const u = await registerUser(ctx, { onboarding: onboardingPayload({ acceptedGoal: MOCK_GOAL }) });

    // Goal changes on Oct 5.
    ctx.setNow(new Date('2026-10-05T05:00:00Z'));
    await ctx.http.put(`${api}/me/goals`).set(u.auth).send({ calories: 1800 });

    ctx.setNow(new Date('2026-10-07T05:00:00Z')); // 12:00 in Phnom Penh
    const logged = await ctx.http.post(`${api}/me/weight-logs`).set(u.auth).send({ weightKg: 53.2, loggedAt: '2026-10-06T01:00:00Z' });
    expect(logged.status).toBe(201);
    const day = (d: number, h = 3) => `2026-10-0${d}T0${h}:00:00Z`;
    await manual(ctx, u, { calories: 500, proteinG: 20, carbsG: 50, fatG: 10, loggedAt: day(3) });
    await manual(ctx, u, { calories: 700, proteinG: 30, carbsG: 70, fatG: 20, loggedAt: day(5) });
    await manual(ctx, u, { calories: 300, proteinG: 10, carbsG: 30, fatG: 5, loggedAt: day(5, 4) });
    await manual(ctx, u, { calories: 900, proteinG: 40, carbsG: 90, fatG: 30, loggedAt: day(6) });
    await manual(ctx, u, { calories: 600, proteinG: 25, carbsG: 60, fatG: 12, loggedAt: day(7) });
    await analyzeMeal(ctx, u, { loggedAt: day(7, 4) }); // adds healthScore 7 and 460 kcal

    const res = await ctx.http.get(`${api}/analytics/summary`).set(u.auth).query({ range: '7d' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ range: '7d', from: '2026-10-01', to: '2026-10-07', timezone: 'Asia/Phnom_Penh' });
    expect(res.body.days).toHaveLength(7);
    const byDate = Object.fromEntries(res.body.days.map((d: any) => [d.date, d]));
    expect(byDate['2026-10-03']).toMatchObject({ calories: 500, mealCount: 1, goalCalories: 2199 });
    expect(byDate['2026-10-05']).toMatchObject({ calories: 1000, mealCount: 2, goalCalories: 1800 });
    expect(byDate['2026-10-07']).toMatchObject({ calories: 1060, mealCount: 2, goalCalories: 1800 });
    expect(byDate['2026-10-04']).toMatchObject({ calories: 0, mealCount: 0 });

    expect(res.body.loggedDays).toBe(4);
    expect(res.body.averages.calories).toBe(Math.round(((500 + 1000 + 900 + 1060) / 4) * 10) / 10);
    // Oct 5, 6, 7 are consecutive; Oct 4 was empty, so the streak is 3.
    expect(res.body.streak).toEqual({ current: 3, longest: 3 });
    // 54 kg was logged at registration (Oct 1), 53.2 kg on Oct 6.
    expect(res.body.weight).toMatchObject({ startKg: 54, latestKg: 53.2, changeKg: -0.8 });
    expect(res.body.weight.points.map((p: any) => p.date)).toEqual(['2026-10-01', '2026-10-06']);
    expect(res.body.averageHealthScore).toBe(7);
  });

  it('keeps a streak alive through an empty today, and defaults to 7 days', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-07T05:00:00Z') });
    const u = await registerUser(ctx);
    await manual(ctx, u, { loggedAt: '2026-10-05T03:00:00Z' });
    await manual(ctx, u, { loggedAt: '2026-10-06T03:00:00Z' });
    const res = await ctx.http.get(`${api}/analytics/summary`).set(u.auth);
    expect(res.body.range).toBe('7d');
    expect(res.body.streak.current).toBe(2); // today (Oct 7) is still empty but not over
  });

  it('supports 30d and 90d and rejects other ranges', async () => {
    const ctx = createTestContext();
    const u = await registerUser(ctx);
    for (const [range, n] of [['30d', 30], ['90d', 90]] as const) {
      const res = await ctx.http.get(`${api}/analytics/summary`).set(u.auth).query({ range });
      expect(res.body.days).toHaveLength(n);
    }
    expect((await ctx.http.get(`${api}/analytics/summary`).set(u.auth).query({ range: '1y' })).status).toBe(400);
  });

  it('accepts an explicit from/to window that overrides range', async () => {
    const ctx = createTestContext({ now: new Date('2026-10-07T05:00:00Z') });
    const u = await registerUser(ctx);
    await manual(ctx, u, { calories: 400, loggedAt: '2026-10-02T03:00:00Z' });
    await manual(ctx, u, { calories: 500, loggedAt: '2026-10-03T03:00:00Z' });
    await manual(ctx, u, { calories: 600, loggedAt: '2026-10-06T03:00:00Z' });

    const res = await ctx.http.get(`${api}/analytics/summary`).set(u.auth).query({ range: '90d', from: '2026-10-01', to: '2026-10-03' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ range: 'custom', from: '2026-10-01', to: '2026-10-03' });
    expect(res.body.days.map((d: any) => [d.date, d.calories])).toEqual([
      ['2026-10-01', 0],
      ['2026-10-02', 400],
      ['2026-10-03', 500],
    ]);
    // The streak counts back from the window's last day.
    expect(res.body.streak).toEqual({ current: 2, longest: 2 });

    const year = await ctx.http.get(`${api}/analytics/summary`).set(u.auth).query({ from: '2025-10-07', to: '2026-10-07' });
    expect(year.body.days).toHaveLength(366);
  });

  it('rejects an invalid from/to window', async () => {
    const ctx = createTestContext();
    const u = await registerUser(ctx);
    const get = (query: Record<string, string>) => ctx.http.get(`${api}/analytics/summary`).set(u.auth).query(query);
    expect((await get({ from: '2026-10-01' })).status).toBe(400);
    expect((await get({ from: '2026-10-05', to: '2026-10-01' })).status).toBe(400);
    expect((await get({ from: '2025-10-01', to: '2026-10-07' })).status).toBe(400);
    expect((await get({ from: '2026-02-30', to: '2026-03-01' })).status).toBe(400);
  });

  it('is empty-safe for a new user', async () => {
    const ctx = createTestContext();
    const u = await registerUser(ctx);
    const res = await ctx.http.get(`${api}/analytics/summary`).set(u.auth);
    expect(res.body).toMatchObject({ loggedDays: 0, averages: { calories: 0 }, streak: { current: 0, longest: 0 }, averageHealthScore: null });
  });
});
