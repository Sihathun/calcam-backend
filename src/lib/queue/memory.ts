import { TransientError } from '../errors';
import type { JobProcessors, JobQueue } from './index';

/**
 * In-process queue for tests and single-process development (QUEUE_DRIVER=memory).
 * It runs the same processors as the BullMQ worker, with the same retry rule:
 * a TransientError is retried until maxAttempts is reached.
 */
export class MemoryQueue implements JobQueue {
  private processors?: JobProcessors;
  private readonly pending = new Set<Promise<void>>();
  /** Set to true in tests that want to enqueue without running anything. */
  paused = false;
  readonly enqueued: { type: 'meal' | 'account'; id: string }[] = [];

  constructor(
    private readonly maxAttempts = 3,
    private readonly backoffMs = 0,
  ) {}

  setProcessors(p: JobProcessors): void {
    this.processors = p;
  }

  private run(task: () => Promise<void>): void {
    const p = new Promise<void>((resolve) => {
      setImmediate(() => {
        task()
          .catch(() => undefined)
          .finally(resolve);
      });
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async enqueueMealAnalysis(mealId: string): Promise<void> {
    this.enqueued.push({ type: 'meal', id: mealId });
    if (this.paused) return;
    this.run(async () => {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          await this.processors?.analyzeMeal(mealId, { attempt, maxAttempts: this.maxAttempts });
          return;
        } catch (err) {
          if (!(err instanceof TransientError) || attempt === this.maxAttempts) return;
          if (this.backoffMs) await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (attempt - 1)));
        }
      }
    });
  }

  async enqueueAccountDeletion(userId: string): Promise<void> {
    this.enqueued.push({ type: 'account', id: userId });
    if (this.paused) return;
    this.run(async () => {
      await this.processors?.deleteAccount(userId);
    });
  }

  /** Resolves when every queued job has finished. Tests call this instead of sleeping. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {
    await this.drain();
  }
}
