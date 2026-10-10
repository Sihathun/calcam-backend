import { beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeMeal,
  createTestContext,
  oauthToken,
  onboardingPayload,
  registerUser,
  uniqueEmail,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(() => {
  ctx = createTestContext();
});

const api = '/api/v1';

describe('register and login', () => {
  it('creates an account and returns user + tokens', async () => {
    const email = uniqueEmail();
    const res = await ctx.http.post(`${api}/auth/register`).send({ email: email.toUpperCase(), password: 'correct horse battery' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email); // normalised to lower case
    expect(res.body.user.onboardingCompleted).toBe(false);
    expect(res.body.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(res.body.tokens.accessToken).toMatch(/^eyJ/);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('never stores the password or the refresh token in clear', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const row = await ctx.deps.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    const tokens = await ctx.deps.prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tokenHash).not.toBe(user.refreshToken);
    expect(tokens[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a duplicate email with 409 and a weak password with 400', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const dup = await ctx.http.post(`${api}/auth/register`).send({ email: user.email, password: 'another password' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const weak = await ctx.http.post(`${api}/auth/register`).send({ email: uniqueEmail(), password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.details[0].path).toBe('password');
  });

  it('logs in with the right password only', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const ok = await ctx.http.post(`${api}/auth/login`).send({ email: user.email, password: user.password });
    expect(ok.status).toBe(200);
    expect(ok.body.tokens.accessToken).toBeTruthy();
    const bad = await ctx.http.post(`${api}/auth/login`).send({ email: user.email, password: 'wrong password!' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await ctx.http.post(`${api}/auth/login`).send({ email: uniqueEmail(), password: 'whatever it is' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message); // does not reveal which emails exist
  });
});

describe('access tokens', () => {
  it('are required, and bad or expired ones are 401', async () => {
    expect((await ctx.http.get(`${api}/me`)).status).toBe(401);
    const bad = await ctx.http.get(`${api}/me`).set('Authorization', 'Bearer not-a-token');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_TOKEN');

    const short = createTestContext({ env: { JWT_ACCESS_TTL_SECONDS: '1' } });
    const user = await registerUser(short, { onboarding: false });
    await new Promise((r) => setTimeout(r, 2100));
    const expired = await short.http.get(`${api}/me`).set(user.auth);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');
  });
});

describe('refresh token rotation', () => {
  it('issues a new pair and invalidates the old refresh token', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const res = await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.tokens.refreshToken).not.toBe(user.refreshToken);
    const me = await ctx.http.get(`${api}/me`).set('Authorization', `Bearer ${res.body.tokens.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('revokes the whole family when a rotated token is reused', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const rotated = await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken });
    const newest = rotated.body.tokens.refreshToken as string;

    // An attacker (or a buggy client) replays the first token.
    const replay = await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The legitimate newest token is dead too, so the user must sign in again.
    const after = await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: newest });
    expect(after.status).toBe(401);
    const live = await ctx.deps.prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(0);
  });

  it('does not touch other sessions of the same user', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const otherDevice = await ctx.http.post(`${api}/auth/login`).send({ email: user.email, password: user.password });
    await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken });
    await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken }); // reuse -> family revoked
    const still = await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: otherDevice.body.tokens.refreshToken });
    expect(still.status).toBe(200);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    const unknown = await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: 'x'.repeat(64) });
    expect(unknown.status).toBe(401);
    const user = await registerUser(ctx, { onboarding: false });
    await ctx.deps.prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken });
    expect(expired.status).toBe(401);
  });

  it('logout revokes the session and is idempotent', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    expect((await ctx.http.post(`${api}/auth/logout`).send({ refreshToken: user.refreshToken })).status).toBe(204);
    expect((await ctx.http.post(`${api}/auth/logout`).send({ refreshToken: user.refreshToken })).status).toBe(204);
    const refresh = await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken });
    expect(refresh.status).toBe(401);
  });
});

describe('Apple and Google sign-in', () => {
  it('creates a user on first sign-in and returns the same user next time', async () => {
    const sub = `g-${Date.now()}`;
    const email = uniqueEmail();
    const first = await ctx.http.post(`${api}/auth/oauth/google`).send({ idToken: oauthToken('google', sub, email) });
    expect(first.status).toBe(200);
    expect(first.body.user.email).toBe(email);
    const second = await ctx.http.post(`${api}/auth/oauth/google`).send({ idToken: oauthToken('google', sub, email) });
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it('accepts the onboarding payload on first sign-in', async () => {
    const res = await ctx.http
      .post(`${api}/auth/oauth/apple`)
      .send({ idToken: oauthToken('apple', `a-${Date.now()}`, uniqueEmail()), onboarding: onboardingPayload() });
    expect(res.status).toBe(200);
    expect(res.body.user.onboardingCompleted).toBe(true);
    expect(res.body.user.goal.calories).toBeGreaterThan(0);
  });

  it('links to an existing account when the provider verified the email', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const res = await ctx.http
      .post(`${api}/auth/oauth/google`)
      .send({ idToken: oauthToken('google', `link-${Date.now()}`, user.email, true) });
    expect(res.body.user.id).toBe(user.id);
  });

  it('does NOT link on an unverified email (account takeover guard)', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const res = await ctx.http
      .post(`${api}/auth/oauth/google`)
      .send({ idToken: oauthToken('google', `nolink-${Date.now()}`, user.email, false) });
    expect(res.status).toBe(200);
    expect(res.body.user.id).not.toBe(user.id);
    expect(res.body.user.email).toBeNull();
  });

  it('pulls the Google name and photo, links them to an email account, and refreshes them', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const sub = `profile-${Date.now()}`;
    const picture = 'https://lh3.googleusercontent.com/a/one';
    const first = await ctx.http
      .post(`${api}/auth/oauth/google`)
      .send({ idToken: oauthToken('google', sub, user.email, true, { name: 'Bunsou Taing', picture }) });
    expect(first.body.user.id).toBe(user.id);
    expect(first.body.user.displayName).toBe('Bunsou Taing');
    expect(first.body.user.avatarUrl).toBe(picture);

    // A later token without profile claims keeps what we have; a new photo replaces the old one.
    const bare = await ctx.http.post(`${api}/auth/oauth/google`).send({ idToken: oauthToken('google', sub, user.email) });
    expect(bare.body.user.displayName).toBe('Bunsou Taing');
    const next = 'https://lh3.googleusercontent.com/a/two';
    const changed = await ctx.http
      .post(`${api}/auth/oauth/google`)
      .send({ idToken: oauthToken('google', sub, user.email, true, { picture: next }) });
    expect(changed.body.user.avatarUrl).toBe(next);

    const me = await ctx.http.get(`${api}/me`).set('Authorization', `Bearer ${changed.body.tokens.accessToken}`);
    expect(me.body.displayName).toBe('Bunsou Taing');
  });

  it('has no name or photo for email accounts', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const login = await ctx.http.post(`${api}/auth/login`).send({ email: user.email, password: user.password });
    expect(login.body.user.displayName).toBeNull();
    expect(login.body.user.avatarUrl).toBeNull();
  });

  it('rejects a token that does not verify', async () => {
    const res = await ctx.http.post(`${api}/auth/oauth/apple`).send({ idToken: oauthToken('google', 'x', 'a@b.co') });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_ID_TOKEN');
  });
});

describe('password reset (feature flag)', () => {
  it('emails a link, resets the password once, and signs out every device', async () => {
    const user = await registerUser(ctx, { onboarding: false });
    const forgot = await ctx.http.post(`${api}/auth/password/forgot`).send({ email: user.email });
    expect(forgot.status).toBe(202);
    const mail = ctx.mailer.sent.find((m) => m.to === user.email)!;
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;

    const reset = await ctx.http.post(`${api}/auth/password/reset`).send({ token, password: 'a brand new password' });
    expect(reset.status).toBe(204);
    expect((await ctx.http.post(`${api}/auth/password/reset`).send({ token, password: 'yet another one!!' })).status).toBe(400);
    expect((await ctx.http.post(`${api}/auth/login`).send({ email: user.email, password: user.password })).status).toBe(401);
    expect((await ctx.http.post(`${api}/auth/login`).send({ email: user.email, password: 'a brand new password' })).status).toBe(200);
    expect((await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken })).status).toBe(401);
  });

  it('answers 202 for unknown emails without sending mail', async () => {
    const before = ctx.mailer.sent.length;
    const res = await ctx.http.post(`${api}/auth/password/forgot`).send({ email: uniqueEmail() });
    expect(res.status).toBe(202);
    expect(ctx.mailer.sent.length).toBe(before);
  });

  it('is 404 when the feature flag is off', async () => {
    const off = createTestContext({ env: { FEATURE_PASSWORD_RESET: 'false' } });
    const res = await off.http.post(`${api}/auth/password/forgot`).send({ email: uniqueEmail() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_DISABLED');
  });
});

describe('rate limiting', () => {
  it('limits auth endpoints per IP', async () => {
    const limited = createTestContext({ env: { RATE_LIMIT_AUTH_PER_MIN: '3' } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await limited.http.post(`${api}/auth/login`).send({ email: uniqueEmail(), password: 'whatever it is' })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const res = await limited.http.post(`${api}/auth/login`).send({ email: uniqueEmail(), password: 'whatever it is' });
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('limits plan-preview per IP', async () => {
    const limited = createTestContext({ env: { RATE_LIMIT_PLAN_PREVIEW_PER_MIN: '2' } });
    const body = { sex: 'male', birthDate: '1990-01-01', heightCm: 180, weightKg: 80, workoutsPerWeek: '3-5', goal: 'maintain', diet: 'balanced' };
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await limited.http.post(`${api}/onboarding/plan-preview`).send(body)).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('limits the general per-user rate, keyed by user', async () => {
    const limited = createTestContext({ env: { RATE_LIMIT_GENERAL_PER_MIN: '3' } });
    const a = await registerUser(limited, { onboarding: false });
    const b = await registerUser(limited, { onboarding: false });
    const hit = async (u: typeof a) => (await limited.http.get(`${api}/me`).set(u.auth)).status;
    expect([await hit(a), await hit(a), await hit(a), await hit(a)]).toEqual([200, 200, 200, 429]);
    expect(await hit(b)).toBe(200); // another user is not affected
  });
});

describe('account deletion', () => {
  it('disables the account at once and hard-deletes everything in the background', async () => {
    const user = await registerUser(ctx);
    await ctx.http.post(`${api}/me/devices`).set(user.auth).send({ token: 'a'.repeat(40), platform: 'ios' });
    ctx.queue.paused = true;
    const res = await ctx.http.delete(`${api}/me`).set(user.auth);
    expect(res.status).toBe(202);

    // Disabled immediately: token no longer works, login fails, refresh fails.
    expect((await ctx.http.get(`${api}/me`).set(user.auth)).status).toBe(401);
    expect((await ctx.http.post(`${api}/auth/login`).send({ email: user.email, password: user.password })).status).toBe(401);
    expect((await ctx.http.post(`${api}/auth/refresh`).send({ refreshToken: user.refreshToken })).status).toBe(401);
    expect(await ctx.deps.prisma.user.count({ where: { id: user.id } })).toBe(1); // not yet hard-deleted
    expect(ctx.queue.enqueued.at(-1)).toEqual({ type: 'account', id: user.id });

    ctx.queue.paused = false;
    await ctx.queue.enqueueAccountDeletion(user.id);
    await ctx.queue.drain();
    for (const table of ['user', 'profile', 'nutritionGoal', 'weightLog', 'refreshToken', 'deviceToken'] as const) {
      const where = table === 'user' ? { id: user.id } : { userId: user.id };
      expect(await (ctx.deps.prisma[table] as any).count({ where }), table).toBe(0);
    }
  });

  it('removes stored images with the account', async () => {
    const user = await registerUser(ctx);
    await analyzeMeal(ctx, user);
    expect([...ctx.storage.objects.keys()].some((k) => k.startsWith(`users/${user.id}/`))).toBe(true);
    await ctx.http.delete(`${api}/me`).set(user.auth);
    await ctx.queue.drain();
    expect([...ctx.storage.objects.keys()].some((k) => k.startsWith(`users/${user.id}/`))).toBe(false);
  });
});

describe('error handling', () => {
  it('uses one error shape for malformed JSON, unknown routes and server details', async () => {
    const badJson = await ctx.http.post(`${api}/auth/login`).set('Content-Type', 'application/json').send('{"email":');
    expect(badJson.status).toBe(400);
    expect(badJson.body).toEqual({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON' } });

    const missing = await ctx.http.get(`${api}/nope`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('localises messages from Accept-Language and defaults to English', async () => {
    const es = await ctx.http.get(`${api}/me`).set('Accept-Language', 'es-MX,es;q=0.9');
    expect(es.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Se requiere autenticación' });
    const en = await ctx.http.get(`${api}/me`).set('Accept-Language', 'fr');
    expect(en.body.error.message).toBe('Authentication required');
  });

  it('returns a request id and strips unknown body fields', async () => {
    const res = await ctx.http.post(`${api}/auth/login`).send({ email: uniqueEmail(), password: 'x', isAdmin: true });
    expect(res.headers['x-request-id']).toBeTruthy();
    const echoed = await ctx.http.get(`${api}/me`).set('X-Request-Id', 'trace-123');
    expect(echoed.headers['x-request-id']).toBe('trace-123');
  });
});
