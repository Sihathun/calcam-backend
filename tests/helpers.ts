import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import sharp from 'sharp';
import supertest from 'supertest';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config/env';
import { createPrisma, type AppDeps, type WorkerDeps } from '../src/deps';
import { FakeAnalyzer } from '../src/lib/analyzer/fake';
import { MemoryCache } from '../src/lib/cache';
import { noopReporter } from '../src/lib/error-reporter';
import { createLogger } from '../src/lib/logger';
import { LogMailer } from '../src/lib/mail';
import type { OAuthIdentity, OAuthProvider, OAuthVerifier } from '../src/lib/oauth';
import { CachedProductLookup, type ProductInfo, type ProductLookup } from '../src/lib/product-lookup';
import { LogPushSender } from '../src/lib/push';
import { MemoryQueue } from '../src/lib/queue/memory';
import { MemoryStorage } from '../src/lib/storage/memory';
import { buildProcessors } from '../src/modules';
import { unauthorized } from '../src/lib/errors';

/** "fake:<provider>:<sub>:<email>:<verified>[:<name>:<picture>]" tokens (name and picture URI-encoded), so tests can sign in as anyone. */
export class FakeOAuth implements OAuthVerifier {
  async verify(provider: OAuthProvider, idToken: string): Promise<OAuthIdentity> {
    const [prefix, p, sub, email, verified, name, picture] = idToken.split(':');
    if (prefix !== 'fake' || p !== provider || !sub) throw unauthorized('INVALID_ID_TOKEN', 'bad token');
    return {
      sub,
      email: email || undefined,
      emailVerified: verified === 'true',
      name: name ? decodeURIComponent(name) : undefined,
      pictureUrl: picture ? decodeURIComponent(picture) : undefined,
    };
  }
}
export const oauthToken = (
  provider: OAuthProvider,
  sub: string,
  email = '',
  verified = true,
  profile: { name?: string; picture?: string } = {},
) =>
  `fake:${provider}:${sub}:${email}:${verified}:${encodeURIComponent(profile.name ?? '')}:${encodeURIComponent(profile.picture ?? '')}`;

export class FakeProductLookup implements ProductLookup {
  lookups = 0;
  products = new Map<string, ProductInfo>([
    [
      '3017620422003',
      {
        barcode: '3017620422003',
        name: 'Hazelnut Spread',
        brand: 'Nutella',
        servingSize: '15 g',
        calories: 80,
        proteinG: 0.9,
        carbsG: 8.6,
        fatG: 4.6,
        healthScore: 2,
        imageUrl: 'https://images.example.com/spread.jpg',
      },
    ],
  ]);
  async findByBarcode(barcode: string) {
    this.lookups += 1;
    return this.products.get(barcode) ?? null;
  }
}

export interface TestContext {
  app: Express;
  config: Config;
  deps: AppDeps;
  queue: MemoryQueue;
  storage: MemoryStorage;
  push: LogPushSender;
  analyzer: FakeAnalyzer;
  mailer: LogMailer;
  products: FakeProductLookup;
  /** Moves the clock the app and worker see. */
  setNow(d: Date): void;
  http: ReturnType<typeof supertest>;
}

const sharedPrisma = new Map<string, ReturnType<typeof createPrisma>>();

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const url = process.env['TEST_DB_URL'];
  if (!url) throw new Error('TEST_DB_URL missing: integration tests must run through the vitest integration project');
  return {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret',
    STORAGE_DRIVER: 'memory',
    QUEUE_DRIVER: 'memory',
    AI_PROVIDER: 'fake',
    PUSH_DRIVER: 'log',
    MAIL_DRIVER: 'log',
    LOG_LEVEL: 'silent',
    FEATURE_PASSWORD_RESET: 'true',
    QUEUE_BACKOFF_MS: '0',
    // High enough to be invisible; the rate-limit test builds its own app with low values.
    RATE_LIMIT_AUTH_PER_MIN: '100000',
    RATE_LIMIT_PLAN_PREVIEW_PER_MIN: '100000',
    RATE_LIMIT_ANALYZE_PER_HOUR: '100000',
    RATE_LIMIT_GENERAL_PER_MIN: '100000',
    GOOGLE_OAUTH_CLIENT_IDS: 'test-google',
    APPLE_CLIENT_IDS: 'test.apple',
    SUPPORTED_LOCALES: 'en,es',
    ...overrides,
  };
}

export function createTestContext(opts: { env?: Record<string, string>; now?: Date } = {}): TestContext {
  const config = loadConfig(testEnv(opts.env));
  const logger = createLogger(config);
  let now: Date | undefined = opts.now;
  const clock = () => now ?? new Date();

  let prisma = sharedPrisma.get(config.databaseUrl);
  if (!prisma) {
    prisma = createPrisma(config);
    sharedPrisma.set(config.databaseUrl, prisma);
  }

  const storage = new MemoryStorage();
  const push = new LogPushSender();
  const analyzer = new FakeAnalyzer();
  const mailer = new LogMailer();
  const products = new FakeProductLookup();
  const queue = new MemoryQueue(config.queue.attempts, 0);

  const workerDeps: WorkerDeps = { config, logger, prisma, storage, analyzer, push, errorReporter: noopReporter, clock };
  queue.setProcessors(buildProcessors(workerDeps));

  const deps: AppDeps = {
    config,
    logger,
    prisma,
    storage,
    queue,
    oauth: new FakeOAuth(),
    mailer,
    productLookup: new CachedProductLookup(products, new MemoryCache(), 60),
    errorReporter: noopReporter,
    probes: [
      { name: 'database', check: async () => void (await prisma!.$queryRaw`SELECT 1`) },
      { name: 'storage', check: () => storage.ping() },
    ],
    clock,
    close: async () => {},
  };

  const app = createApp(deps);
  return {
    app,
    config,
    deps,
    queue,
    storage,
    push,
    analyzer,
    mailer,
    products,
    setNow: (d) => {
      now = d;
    },
    http: supertest(app),
  };
}

// ---------- fixtures ----------

/** The sample onboarding payload from the API spec. */
export const onboardingPayload = (over: Record<string, unknown> = {}) => ({
  sex: 'female',
  workoutsPerWeek: '0-2',
  referralSource: 'tiktok',
  heightCm: 167.6,
  weightKg: 54.0,
  birthDate: '2001-01-01',
  goal: 'maintain',
  targetWeightKg: null,
  triedOtherApps: true,
  worksWithProfessional: false,
  diet: 'balanced',
  accomplishment: 'eat_healthier',
  heightUnitPref: 'ft_in',
  weightUnitPref: 'kg',
  locale: 'en',
  timezone: 'Asia/Phnom_Penh',
  commitment: { committedAt: '2026-10-06T15:00:00Z' },
  ...over,
});

export const uniqueEmail = () => `user-${randomUUID()}@example.com`;

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  auth: { Authorization: string };
}

/** Registers a user (with onboarding unless `onboarding: false`) and returns their tokens. */
export async function registerUser(
  ctx: TestContext,
  opts: { onboarding?: Record<string, unknown> | false } = {},
): Promise<TestUser> {
  const email = uniqueEmail();
  const password = 'correct horse battery';
  const body: Record<string, unknown> = { email, password };
  if (opts.onboarding !== false) body['onboarding'] = opts.onboarding ?? onboardingPayload();
  const res = await ctx.http.post('/api/v1/auth/register').send(body);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    id: res.body.user.id,
    email,
    password,
    accessToken: res.body.tokens.accessToken,
    refreshToken: res.body.tokens.refreshToken,
    auth: { Authorization: `Bearer ${res.body.tokens.accessToken}` },
  };
}

export async function jpeg(width = 800, height = 600, withExif = false): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } } });
  if (withExif) img = img.withExif({ IFD0: { Copyright: 'secret-copyright', Artist: 'secret-artist' } });
  return img.jpeg().toBuffer();
}

export async function uploadMeal(
  ctx: TestContext,
  user: TestUser,
  fields: { hint?: string; loggedAt?: string; source?: string; idempotencyKey?: string; image?: Buffer } = {},
) {
  const image = fields.image ?? (await jpeg());
  let req = ctx.http.post('/api/v1/meals/analyze').set(user.auth).attach('image', image, { filename: 'meal.jpg', contentType: 'image/jpeg' });
  if (fields.hint) req = req.field('hint', fields.hint);
  if (fields.loggedAt) req = req.field('loggedAt', fields.loggedAt);
  if (fields.source) req = req.field('source', fields.source);
  if (fields.idempotencyKey) req = req.set('Idempotency-Key', fields.idempotencyKey);
  return req;
}

/** Creates a photo meal and waits for the in-memory worker to finish it. */
export async function analyzeMeal(ctx: TestContext, user: TestUser, fields: Parameters<typeof uploadMeal>[2] = {}) {
  const res = await uploadMeal(ctx, user, fields);
  if (res.status !== 202) throw new Error(`analyze failed: ${res.status} ${JSON.stringify(res.body)}`);
  await ctx.queue.drain();
  const detail = await ctx.http.get(`/api/v1/meals/${res.body.meal.id}`).set(user.auth);
  return detail.body.meal as Record<string, any>;
}
