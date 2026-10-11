import { beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, onboardingPayload, registerUser, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(() => {
  ctx = createTestContext();
});

describe('GET /onboarding/options', () => {
  it('returns codes with the labels from the design, without authentication', async () => {
    const res = await ctx.http.get('/api/v1/onboarding/options');
    expect(res.status).toBe(200);
    expect(res.body.sex).toEqual([
      { code: 'male', label: 'Male' },
      { code: 'female', label: 'Female' },
      { code: 'other', label: 'Other' },
    ]);
    expect(res.body.workoutsPerWeek).toEqual([
      { code: 'sedentary', label: 'Sedentary', description: 'Office job, little or no exercise' },
      { code: 'light', label: 'Light exercise', description: '1-2 days per week' },
      { code: 'moderate', label: 'Moderate exercise', description: '3-5 days per week' },
      { code: 'heavy', label: 'Heavy exercise', description: '6-7 days per week' },
      { code: 'athlete', label: 'Athlete', description: 'Twice per day' },
    ]);
    expect(res.body.referralSources.map((r: any) => r.code)).toEqual([
      'instagram', 'facebook', 'tiktok', 'youtube', 'google', 'x', 'friend_or_family', 'play_store',
    ]);
    expect(res.body.referralSources[2].label).toBe('Tik Tok');
    expect(res.body.diets).toHaveLength(10);
    expect(res.body.goals.map((g: any) => g.label)).toEqual(['Lose Weight', 'Maintain', 'Gain Weight']);
    expect(res.body.accomplishments.map((a: any) => a.code)).toEqual([
      'eat_healthier', 'boost_energy_mood', 'stay_motivated', 'feel_better_body',
    ]);
    expect(res.body.locales).toEqual([
      { code: 'en', label: 'English' },
      { code: 'es', label: 'español' },
    ]);
    expect(res.body.goalLimits.calories).toEqual({ min: 800, max: 6000 });
  });
});

describe('POST /onboarding/plan-preview', () => {
  const body = {
    sex: 'female',
    birthDate: '2001-01-01',
    heightCm: 167.6,
    weightKg: 54,
    workoutsPerWeek: 'light',
    goal: 'maintain',
    diet: 'balanced',
  };

  it('is public, stateless and returns the plan, info card and projection points', async () => {
    const res = await ctx.http.post('/api/v1/onboarding/plan-preview').send(body);
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ activityLevel: 'light', healthScoreEnabled: true });
    expect(res.body.plan.calories).toBeGreaterThan(1000);
    // The pledge and "Your info" screens show the current weight as the target when maintaining.
    expect(res.body.info).toEqual({ weightKg: 54, activityLevel: 'light', goal: 'maintain', targetWeightKg: 54 });
    expect(res.body.projection.map((p: any) => [p.day, p.progress])).toEqual([[3, 0.1], [7, 0.35], [30, 1]]);
    expect(res.body.limits.proteinG.min).toBe(0);
    const users = await ctx.deps.prisma.user.count({ where: { email: null, appleSub: null, googleSub: null } });
    expect(users).toBe(0);
  });

  it('answers 422 GOAL_NOT_SUPPORTED when losing weight is not advisable (BMI < 18.5)', async () => {
    const res = await ctx.http.post('/api/v1/onboarding/plan-preview').send({ ...body, weightKg: 45, goal: 'lose' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GOAL_NOT_SUPPORTED');
    // The same person can still get a Maintain plan, as in the mock-up (45 kg).
    const ok = await ctx.http.post('/api/v1/onboarding/plan-preview').send({ ...body, weightKg: 45 });
    expect(ok.status).toBe(200);
  });

  it('rejects users under 13', async () => {
    const year = new Date().getUTCFullYear() - 10;
    const res = await ctx.http.post('/api/v1/onboarding/plan-preview').send({ ...body, birthDate: `${year}-01-01` });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNDER_MINIMUM_AGE');
  });

  it('validates input with the documented error shape', async () => {
    const res = await ctx.http.post('/api/v1/onboarding/plan-preview').send({ ...body, heightCm: 'tall', sex: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: any) => d.path).sort()).toEqual(['heightCm', 'sex']);
  });
});

describe('register with the onboarding payload', () => {
  it('stores profile, goal, first weight and commitment in one call', async () => {
    const user = await registerUser(ctx);
    const me = await ctx.http.get('/api/v1/me').set(user.auth);
    expect(me.status).toBe(200);
    expect(me.body.onboardingCompleted).toBe(true);
    expect(me.body.timezone).toBe('Asia/Phnom_Penh');
    expect(me.body.profile).toMatchObject({
      sex: 'female',
      workoutsPerWeek: 'light',
      heightCm: 167.6,
      heightUnitPref: 'ft_in',
      weightKg: 54,
      targetWeightKg: 54,
      goal: 'maintain',
      accomplishment: 'eat_healthier',
      referralSource: 'tiktok',
      triedOtherApps: true,
      worksWithProfessional: false,
      commitmentAt: '2026-10-06T15:00:00.000Z',
    });
    expect(me.body.goal.source).toBe('calculated');
    const weights = await ctx.http.get('/api/v1/me/weight-logs').set(user.auth);
    expect(weights.body.items).toHaveLength(1);
    expect(weights.body.items[0].weightKg).toBe(54);
  });

  it('stores edited macros as user_edited and clamps out-of-range values', async () => {
    const user = await registerUser(ctx, {
      onboarding: onboardingPayload({ acceptedGoal: { calories: 1288, proteinG: 69, carbsG: 172, fatG: 36 } }),
    });
    const me = await ctx.http.get('/api/v1/me').set(user.auth);
    expect(me.body.goal).toMatchObject({ source: 'user_edited', calories: 1288, proteinG: 69, carbsG: 172, fatG: 36 });

    const clamped = await registerUser(ctx, {
      onboarding: onboardingPayload({ acceptedGoal: { calories: 50, proteinG: -10, fatG: 99999 } }),
    });
    const me2 = await ctx.http.get('/api/v1/me').set(clamped.auth);
    expect(me2.body.goal.calories).toBe(800);
    expect(me2.body.goal.proteinG).toBe(0);
    expect(me2.body.goal.fatG).toBe(500);
    // Fields that were not edited keep the calculated value.
    expect(me2.body.goal.carbsG).toBeGreaterThan(0);
  });

  it('keeps survey answers out of the plan formula', async () => {
    const a = await ctx.http.post('/api/v1/onboarding/plan-preview').send({
      sex: 'male', birthDate: '1990-05-05', heightCm: 180, weightKg: 80, workoutsPerWeek: 'moderate', goal: 'gain', diet: 'keto',
      accomplishment: 'boost_energy_mood', referralSource: 'google',
    });
    const b = await ctx.http.post('/api/v1/onboarding/plan-preview').send({
      sex: 'male', birthDate: '1990-05-05', heightCm: 180, weightKg: 80, workoutsPerWeek: 'moderate', goal: 'gain', diet: 'keto',
      accomplishment: 'feel_better_body', referralSource: 'x',
    });
    expect(a.body.plan).toEqual(b.body.plan);
  });

  it('is all-or-nothing: a rejected plan creates no account', async () => {
    const email = `nothing-${Date.now()}@example.com`;
    const res = await ctx.http
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct horse battery', onboarding: onboardingPayload({ weightKg: 45, goal: 'lose' }) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GOAL_NOT_SUPPORTED');
    expect(await ctx.deps.prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('ignores a commitment timestamp from the future', async () => {
    const user = await registerUser(ctx, {
      onboarding: onboardingPayload({ commitment: { committedAt: '2099-01-01T00:00:00Z' } }),
    });
    const me = await ctx.http.get('/api/v1/me').set(user.auth);
    expect(new Date(me.body.profile.commitmentAt).getFullYear()).toBeLessThan(2099);
  });
});

describe('POST /onboarding/complete', () => {
  it('is authenticated', async () => {
    const res = await ctx.http.post('/api/v1/onboarding/complete').send(onboardingPayload());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('saves the answers for a user who signed up first, and is idempotent', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const before = await ctx.http.get('/api/v1/me').set(user.auth);
    expect(before.body.onboardingCompleted).toBe(false);
    expect(before.body.goal).toBeNull();

    const first = await ctx.http.post('/api/v1/onboarding/complete').set(user.auth).send(onboardingPayload());
    expect(first.status).toBe(200);
    expect(first.body.onboardingCompleted).toBe(true);

    // A second call, even with different answers, changes nothing and creates no duplicate rows.
    const second = await ctx.http
      .post('/api/v1/onboarding/complete')
      .set(user.auth)
      .send(onboardingPayload({ weightKg: 99, goal: 'gain' }));
    expect(second.status).toBe(200);
    expect(second.body.profile.goal).toBe('maintain');
    expect(second.body.goal.id).toBe(first.body.goal.id);
    expect(await ctx.deps.prisma.weightLog.count({ where: { userId: user.id } })).toBe(1);
    expect(await ctx.deps.prisma.nutritionGoal.count({ where: { userId: user.id } })).toBe(1);
  });
});
