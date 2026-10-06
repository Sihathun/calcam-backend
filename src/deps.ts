import { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Config } from './config/env';
import { createAnalyzer, type MealAnalyzer } from './lib/analyzer';
import { MemoryCache, RedisCache, type Cache } from './lib/cache';
import { createErrorReporter, noopReporter, type ErrorReporter } from './lib/error-reporter';
import { createLogger } from './lib/logger';
import { createMailer, type Mailer } from './lib/mail';
import { JoseOAuthVerifier, type OAuthVerifier } from './lib/oauth';
import { CachedProductLookup, OpenFoodFactsLookup, type ProductLookup } from './lib/product-lookup';
import { createPushSender, type PushSender } from './lib/push';
import { BullJobQueue, startBullWorkers } from './lib/queue/bullmq';
import type { JobProcessors, JobQueue } from './lib/queue';
import { MemoryQueue } from './lib/queue/memory';
import { createQueueRedis, createRedis } from './lib/redis';
import { createStorage, type ObjectStorage } from './lib/storage';
import type { Redis } from 'ioredis';

export interface Probe {
  name: string;
  check: () => Promise<void>;
}

/** Everything the API process needs. Note that it has no MealAnalyzer: only the worker calls the AI provider. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  storage: ObjectStorage;
  queue: JobQueue;
  oauth: OAuthVerifier;
  mailer: Mailer;
  productLookup: ProductLookup;
  errorReporter: ErrorReporter;
  /** Redis client used by the rate limiters, when RATE_LIMIT_STORE=redis. */
  redis?: Redis;
  probes: Probe[];
  /** Injectable clock, so tests can pin "now" around midnight. */
  clock: () => Date;
  close: () => Promise<void>;
}

export interface WorkerDeps {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  storage: ObjectStorage;
  analyzer: MealAnalyzer;
  push: PushSender;
  errorReporter: ErrorReporter;
  clock: () => Date;
}

export function createPrisma(config: Config): PrismaClient {
  return new PrismaClient({ datasourceUrl: config.databaseUrl, log: [{ emit: 'stdout', level: 'error' }] });
}

export async function buildWorkerDeps(config: Config, logger: Logger, prisma: PrismaClient): Promise<WorkerDeps> {
  return {
    config,
    logger,
    prisma,
    storage: createStorage(config),
    analyzer: createAnalyzer(config),
    push: createPushSender(config, logger),
    errorReporter: await createErrorReporter(config, logger),
    clock: () => new Date(),
  };
}

/**
 * Wires the real implementations from configuration.
 * With QUEUE_DRIVER=memory (development only) the worker logic runs inside this process.
 * `makeProcessors` is injected to keep this file free of module imports.
 */
export async function buildApiDeps(
  config: Config,
  makeProcessors: (w: WorkerDeps) => JobProcessors,
  overrides: Partial<AppDeps> = {},
): Promise<AppDeps> {
  const logger = createLogger(config);
  const prisma = overrides.prisma ?? createPrisma(config);
  const redis = config.redisUrl ? createRedis(config.redisUrl) : undefined;
  const closers: (() => Promise<unknown>)[] = [];
  if (redis) closers.push(() => redis.quit());

  const cache: Cache = redis ? new RedisCache(redis) : new MemoryCache();

  let queue: JobQueue;
  if (config.queue.driver === 'bullmq') {
    if (!config.redisUrl) throw new Error('QUEUE_DRIVER=bullmq requires REDIS_URL');
    const conn = createQueueRedis(config.redisUrl);
    queue = new BullJobQueue(conn, config);
    closers.push(() => queue.close(), () => conn.quit());
  } else {
    const memory = new MemoryQueue(config.queue.attempts, config.queue.backoffMs);
    memory.setProcessors(makeProcessors(await buildWorkerDeps(config, logger, prisma)));
    queue = memory;
  }

  const storage = createStorage(config);
  const probes: Probe[] = [
    { name: 'database', check: async () => void (await prisma.$queryRaw`SELECT 1`) },
    { name: 'storage', check: () => storage.ping() },
    { name: 'queue', check: () => queue.ping() },
  ];
  if (redis) probes.push({ name: 'redis', check: async () => void (await redis.ping()) });

  const deps: AppDeps = {
    config,
    logger,
    prisma,
    storage,
    queue,
    oauth: new JoseOAuthVerifier(config),
    mailer: createMailer(config, logger),
    productLookup: new CachedProductLookup(
      new OpenFoodFactsLookup(config),
      cache,
      config.productLookup.cacheTtlSeconds,
    ),
    errorReporter: await createErrorReporter(config, logger),
    redis: config.rateLimit.store === 'redis' ? redis : undefined,
    probes,
    clock: () => new Date(),
    close: async () => {
      for (const c of closers.reverse()) await c().catch(() => undefined);
      await prisma.$disconnect();
    },
    ...overrides,
  };
  return deps;
}

export { startBullWorkers, noopReporter };
