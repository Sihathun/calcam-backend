import { z } from 'zod';
import { defaultPlanConfig, type PlanConfig } from './plan';

const num = (def: number) => z.coerce.number().default(def);
const int = (def: number) => z.coerce.number().int().default(def);
const bool = (def: boolean) => z.stringbool().default(def);
const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),
  APP_NAME: z.string().default('CalorieScan AI'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.string().optional(),
  CORS_ORIGINS: csv,
  TRUST_PROXY: int(0),
  SUPPORTED_LOCALES: z.string().default('en'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL_SECONDS: int(900),
  REFRESH_TOKEN_TTL_DAYS: int(30),
  PASSWORD_RESET_TTL_MINUTES: int(30),
  FEATURE_PASSWORD_RESET: bool(false),

  STORAGE_DRIVER: z.enum(['s3', 'cloudinary', 'fs', 'memory']).default('s3'),
  STORAGE_FS_DIR: z.string().default('.local/storage'),
  STORAGE_SIGNING_SECRET: z.string().optional(),
  S3_BUCKET: z.string().default('calcam-meals'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(false),
  S3_SSE: z.enum(['AES256', 'aws:kms', 'none']).default('none'),
  SIGNED_URL_TTL_SECONDS: int(900),
  CLOUDINARY_URL: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default(''),
  CLOUDINARY_AUTH_TOKEN_KEY: z.string().regex(/^[0-9a-fA-F]+$/, 'must be the hex key from Cloudinary token-based authentication').optional(),

  QUEUE_DRIVER: z.enum(['bullmq', 'memory']).default('bullmq'),
  QUEUE_CONCURRENCY: int(4),
  QUEUE_ATTEMPTS: int(3),
  QUEUE_BACKOFF_MS: int(2000),

  AI_PROVIDER: z.enum(['anthropic', 'openai', 'fake']).default('anthropic'),
  AI_MODEL: z.string().optional(),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  AI_MIN_CONFIDENCE: num(0.3),
  AI_TIMEOUT_MS: int(60000),
  AI_MAX_CALORIES_PER_SERVING: int(5000),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),

  PUSH_DRIVER: z.enum(['fcm', 'log']).default('log'),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  GOOGLE_OAUTH_CLIENT_IDS: csv,
  APPLE_CLIENT_IDS: csv,

  MAIL_DRIVER: z.enum(['smtp', 'log']).default('log'),
  MAIL_FROM: z.string().default('no-reply@example.com'),
  SMTP_URL: z.string().optional(),
  PASSWORD_RESET_URL: z.string().default('calcam://reset-password'),

  RATE_LIMIT_STORE: z.enum(['redis', 'memory']).optional(),
  RATE_LIMIT_AUTH_PER_MIN: int(10),
  RATE_LIMIT_PLAN_PREVIEW_PER_MIN: int(30),
  RATE_LIMIT_ANALYZE_PER_HOUR: int(20),
  RATE_LIMIT_GENERAL_PER_MIN: int(300),

  UPLOAD_MAX_BYTES: int(10 * 1024 * 1024),
  IMAGE_MAX_DIMENSION: int(1280),

  OPEN_FOOD_FACTS_BASE_URL: z.string().default('https://world.openfoodfacts.org'),
  PRODUCT_CACHE_TTL_SECONDS: int(60 * 60 * 24),

  RECALC_WEIGHT_DELTA_KG: num(1),

  PLAN_CALORIE_FLOOR_MALE: int(defaultPlanConfig.loseCalorieFloor.male),
  PLAN_CALORIE_FLOOR_FEMALE: int(defaultPlanConfig.loseCalorieFloor.female),
  PLAN_ADJUST_LOSE: num(defaultPlanConfig.goalAdjustment.lose),
  PLAN_ADJUST_GAIN: num(defaultPlanConfig.goalAdjustment.gain),
  PLAN_MIN_BMI_FOR_LOSE: num(defaultPlanConfig.minBmiForLose),

  SENTRY_DSN: z.string().optional(),
  METRICS_ENABLED: bool(false),
});

type Env = z.infer<typeof EnvSchema>;

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Optional prefix for every public id, e.g. "calcam/prod", to keep environments apart in one Cloudinary account. */
  folder: string;
  /** Key of Cloudinary's token-based authentication. When set, signed links expire after SIGNED_URL_TTL_SECONDS. */
  authTokenKey?: string;
}

/** CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET win; otherwise CLOUDINARY_URL=cloudinary://KEY:SECRET@CLOUD_NAME. */
function readCloudinary(e: Env): CloudinaryConfig | undefined {
  const rest = { folder: e.CLOUDINARY_FOLDER, ...(e.CLOUDINARY_AUTH_TOKEN_KEY ? { authTokenKey: e.CLOUDINARY_AUTH_TOKEN_KEY } : {}) };
  if (e.CLOUDINARY_CLOUD_NAME && e.CLOUDINARY_API_KEY && e.CLOUDINARY_API_SECRET) {
    return { cloudName: e.CLOUDINARY_CLOUD_NAME, apiKey: e.CLOUDINARY_API_KEY, apiSecret: e.CLOUDINARY_API_SECRET, ...rest };
  }
  if (!e.CLOUDINARY_URL) return undefined;
  try {
    const u = new URL(e.CLOUDINARY_URL);
    if (u.protocol === 'cloudinary:' && u.username && u.password && u.hostname) {
      return { cloudName: u.hostname, apiKey: decodeURIComponent(u.username), apiSecret: decodeURIComponent(u.password), ...rest };
    }
  } catch {
    /* reported below */
  }
  throw new Error('Invalid environment configuration:\n  CLOUDINARY_URL: expected cloudinary://API_KEY:API_SECRET@CLOUD_NAME');
}

export interface Config {
  env: Env['NODE_ENV'];
  isProd: boolean;
  isTest: boolean;
  port: number;
  appName: string;
  logLevel: Env['LOG_LEVEL'];
  publicBaseUrl: string;
  corsOrigins: string[];
  /** Number of reverse-proxy hops in front of the API (ALB = 1). Needed for correct client IPs in rate limits. */
  trustProxy: number;
  supportedLocales: string[];
  databaseUrl: string;
  redisUrl?: string;
  auth: {
    accessSecret: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
    passwordResetTtlMinutes: number;
    passwordResetEnabled: boolean;
  };
  storage: {
    driver: Env['STORAGE_DRIVER'];
    fsDir: string;
    signingSecret: string;
    bucket: string;
    region: string;
    endpoint?: string;
    publicEndpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
    sse?: 'AES256' | 'aws:kms';
    signedUrlTtlSeconds: number;
    /** Present when Cloudinary credentials were supplied (required when driver is "cloudinary"). */
    cloudinary?: CloudinaryConfig;
  };
  queue: { driver: Env['QUEUE_DRIVER']; concurrency: number; attempts: number; backoffMs: number };
  ai: {
    provider: Env['AI_PROVIDER'];
    model: string;
    effort?: Env['AI_EFFORT'];
    minConfidence: number;
    timeoutMs: number;
    maxCaloriesPerServing: number;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    openaiBaseUrl: string;
  };
  push: { driver: Env['PUSH_DRIVER']; firebaseServiceAccountJson?: string };
  oauth: { googleClientIds: string[]; appleClientIds: string[] };
  mail: { driver: Env['MAIL_DRIVER']; from: string; smtpUrl?: string; resetUrl: string };
  rateLimit: {
    store: 'redis' | 'memory';
    authPerMin: number;
    planPreviewPerMin: number;
    analyzePerHour: number;
    generalPerMin: number;
  };
  uploads: { maxBytes: number; maxDimension: number };
  productLookup: { baseUrl: string; cacheTtlSeconds: number };
  recalcWeightDeltaKg: number;
  plan: PlanConfig;
  sentryDsn?: string;
  metricsEnabled: boolean;
}

const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4o',
  fake: 'fake-analyzer',
} as const;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // Treat "X=" in a .env file the same as X being unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const publicBaseUrl = e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`;

  const config: Config = {
    env: e.NODE_ENV,
    isProd,
    isTest: e.NODE_ENV === 'test',
    port: e.PORT,
    appName: e.APP_NAME,
    logLevel: e.LOG_LEVEL,
    publicBaseUrl,
    corsOrigins: e.CORS_ORIGINS,
    trustProxy: e.TRUST_PROXY,
    supportedLocales: e.SUPPORTED_LOCALES.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    auth: {
      accessSecret: e.JWT_ACCESS_SECRET,
      accessTtlSeconds: e.JWT_ACCESS_TTL_SECONDS,
      refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
      passwordResetTtlMinutes: e.PASSWORD_RESET_TTL_MINUTES,
      passwordResetEnabled: e.FEATURE_PASSWORD_RESET,
    },
    storage: {
      driver: e.STORAGE_DRIVER,
      fsDir: e.STORAGE_FS_DIR,
      signingSecret: e.STORAGE_SIGNING_SECRET ?? e.JWT_ACCESS_SECRET,
      bucket: e.S3_BUCKET,
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      sse: e.S3_SSE === 'none' ? undefined : e.S3_SSE,
      signedUrlTtlSeconds: e.SIGNED_URL_TTL_SECONDS,
      cloudinary: readCloudinary(e),
    },
    queue: {
      driver: e.QUEUE_DRIVER,
      concurrency: e.QUEUE_CONCURRENCY,
      attempts: e.QUEUE_ATTEMPTS,
      backoffMs: e.QUEUE_BACKOFF_MS,
    },
    ai: {
      provider: e.AI_PROVIDER,
      model: e.AI_MODEL ?? DEFAULT_MODELS[e.AI_PROVIDER],
      effort: e.AI_EFFORT,
      minConfidence: e.AI_MIN_CONFIDENCE,
      timeoutMs: e.AI_TIMEOUT_MS,
      maxCaloriesPerServing: e.AI_MAX_CALORIES_PER_SERVING,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      openaiApiKey: e.OPENAI_API_KEY,
      openaiBaseUrl: e.OPENAI_BASE_URL,
    },
    push: { driver: e.PUSH_DRIVER, firebaseServiceAccountJson: e.FIREBASE_SERVICE_ACCOUNT_JSON },
    oauth: { googleClientIds: e.GOOGLE_OAUTH_CLIENT_IDS, appleClientIds: e.APPLE_CLIENT_IDS },
    mail: { driver: e.MAIL_DRIVER, from: e.MAIL_FROM, smtpUrl: e.SMTP_URL, resetUrl: e.PASSWORD_RESET_URL },
    rateLimit: {
      store: e.RATE_LIMIT_STORE ?? (e.REDIS_URL ? 'redis' : 'memory'),
      authPerMin: e.RATE_LIMIT_AUTH_PER_MIN,
      planPreviewPerMin: e.RATE_LIMIT_PLAN_PREVIEW_PER_MIN,
      analyzePerHour: e.RATE_LIMIT_ANALYZE_PER_HOUR,
      generalPerMin: e.RATE_LIMIT_GENERAL_PER_MIN,
    },
    uploads: { maxBytes: e.UPLOAD_MAX_BYTES, maxDimension: e.IMAGE_MAX_DIMENSION },
    productLookup: { baseUrl: e.OPEN_FOOD_FACTS_BASE_URL, cacheTtlSeconds: e.PRODUCT_CACHE_TTL_SECONDS },
    recalcWeightDeltaKg: e.RECALC_WEIGHT_DELTA_KG,
    plan: {
      ...defaultPlanConfig,
      goalAdjustment: { ...defaultPlanConfig.goalAdjustment, lose: e.PLAN_ADJUST_LOSE, gain: e.PLAN_ADJUST_GAIN },
      loseCalorieFloor: {
        male: e.PLAN_CALORIE_FLOOR_MALE,
        female: e.PLAN_CALORIE_FLOOR_FEMALE,
        other: e.PLAN_CALORIE_FLOOR_FEMALE,
      },
      minBmiForLose: e.PLAN_MIN_BMI_FOR_LOSE,
    },
    sentryDsn: e.SENTRY_DSN,
    metricsEnabled: e.METRICS_ENABLED,
  };

  if (config.storage.driver === 'cloudinary' && !config.storage.cloudinary) {
    throw new Error(
      'Invalid environment configuration:\n  STORAGE_DRIVER=cloudinary needs CLOUDINARY_URL, or CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET',
    );
  }

  assertProductionSafe(config);
  return config;
}

/** Fail fast when production is pointed at development-only drivers. */
function assertProductionSafe(c: Config): void {
  if (!c.isProd) return;
  const problems: string[] = [];
  if (c.queue.driver === 'memory') problems.push('QUEUE_DRIVER=memory runs the worker inside the API process');
  if (c.storage.driver !== 's3' && c.storage.driver !== 'cloudinary') problems.push(`STORAGE_DRIVER=${c.storage.driver} is not durable`);
  if (c.ai.provider === 'fake') problems.push('AI_PROVIDER=fake returns canned results');
  if (c.auth.accessSecret.length < 32) problems.push('JWT_ACCESS_SECRET must be at least 32 characters');
  if (c.ai.provider === 'anthropic' && !c.ai.anthropicApiKey) problems.push('ANTHROPIC_API_KEY is required');
  if (c.ai.provider === 'openai' && !c.ai.openaiApiKey) problems.push('OPENAI_API_KEY is required');
  if (c.push.driver === 'fcm' && !c.push.firebaseServiceAccountJson && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    problems.push('FCM needs FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
  }
  if (c.auth.passwordResetEnabled && c.mail.driver !== 'smtp') problems.push('FEATURE_PASSWORD_RESET needs MAIL_DRIVER=smtp');
  if (problems.length) {
    throw new Error(`Unsafe production configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}
