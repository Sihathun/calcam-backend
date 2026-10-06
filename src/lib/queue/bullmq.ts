import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '../../config/env';
import { ACCOUNT_QUEUE, MEAL_QUEUE, type JobProcessors, type JobQueue } from './index';

/** Producer used by the API process. */
export class BullJobQueue implements JobQueue {
  private readonly meals: Queue;
  private readonly accounts: Queue;

  constructor(
    private readonly connection: Redis,
    private readonly config: Config,
  ) {
    this.meals = new Queue(MEAL_QUEUE, { connection });
    this.accounts = new Queue(ACCOUNT_QUEUE, { connection });
  }

  async enqueueMealAnalysis(mealId: string): Promise<void> {
    await this.meals.add(
      'analyze',
      { mealId },
      {
        // A fresh id per enqueue, so a "Fix Results" re-run of the same meal is never deduplicated.
        jobId: `meal-${mealId}-${randomUUID()}`,
        attempts: this.config.queue.attempts,
        backoff: { type: 'exponential', delay: this.config.queue.backoffMs },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    );
  }

  async enqueueAccountDeletion(userId: string): Promise<void> {
    await this.accounts.add(
      'delete',
      { userId },
      {
        jobId: `account-${userId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: true,
      },
    );
  }

  async ping(): Promise<void> {
    await this.connection.ping();
  }

  async close(): Promise<void> {
    await Promise.all([this.meals.close(), this.accounts.close()]);
  }
}

/** Consumer used by the worker process. Returns a function that stops both workers gracefully. */
export function startBullWorkers(
  connection: Redis,
  processors: JobProcessors,
  config: Config,
  logger: Logger,
): () => Promise<void> {
  const mealWorker = new Worker(
    MEAL_QUEUE,
    async (job) =>
      processors.analyzeMeal(job.data.mealId as string, {
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? 1,
      }),
    { connection, concurrency: config.queue.concurrency },
  );
  const accountWorker = new Worker(
    ACCOUNT_QUEUE,
    async (job) => processors.deleteAccount(job.data.userId as string),
    { connection, concurrency: 1 },
  );

  for (const w of [mealWorker, accountWorker]) {
    w.on('failed', (job, err) => logger.warn({ queue: w.name, jobId: job?.id, err: err.message }, 'job attempt failed'));
    w.on('error', (err) => logger.error({ queue: w.name, err: err.message }, 'worker error'));
  }

  return async () => {
    await Promise.all([mealWorker.close(), accountWorker.close()]);
  };
}
