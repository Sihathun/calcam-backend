import 'dotenv/config';
import { loadConfig } from './config/env';
import { buildWorkerDeps, createPrisma } from './deps';
import { createLogger } from './lib/logger';
import { startBullWorkers } from './lib/queue/bullmq';
import { createQueueRedis } from './lib/redis';
import { buildProcessors } from './modules';

/**
 * Worker process entry point: meal analysis and account deletion.
 * This is the only process that calls the AI provider.
 */
async function main() {
  const config = loadConfig();
  if (config.queue.driver !== 'bullmq' || !config.redisUrl) {
    throw new Error('The worker needs QUEUE_DRIVER=bullmq and REDIS_URL. (With QUEUE_DRIVER=memory the API runs jobs itself.)');
  }
  const logger = createLogger(config);
  const prisma = createPrisma(config);
  const deps = await buildWorkerDeps(config, logger, prisma);
  const connection = createQueueRedis(config.redisUrl);

  const stopWorkers = startBullWorkers(connection, buildProcessors(deps), config, logger);
  logger.info(
    { concurrency: config.queue.concurrency, provider: config.ai.provider, model: config.ai.model },
    `${config.appName} worker started`,
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker shutting down');
    // Waits for jobs that are already running to finish.
    await stopWorkers();
    await connection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
