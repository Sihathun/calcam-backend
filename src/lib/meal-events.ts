import { EventEmitter } from 'node:events';

/**
 * In-process signal that a meal's analysis settled (completed or failed). The analysis processor emits it; the
 * upload request (`POST /meals/analyze?wait=N`) listens so it can answer with the result the moment it exists.
 * With a separate worker process (BullMQ) nothing reaches this emitter, so waiters also check the database.
 */
const emitter = new EventEmitter();
// Each waiting request adds one listener for its own meal; many scans at once is normal, not a leak.
emitter.setMaxListeners(0);

export function emitMealSettled(mealId: string): void {
  emitter.emit(mealId);
}

/**
 * Resolves when `mealId` settles in this process, or when `isSettled()` (checked every `pollMs`) says it has,
 * or after `timeoutMs`. Returns true when it settled.
 */
export function waitForMealSettled(
  mealId: string,
  timeoutMs: number,
  isSettled: () => Promise<boolean>,
  pollMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      emitter.off(mealId, onSettled);
      clearTimeout(timer);
      clearInterval(poll);
      resolve(settled);
    };
    const onSettled = () => finish(true);
    emitter.on(mealId, onSettled);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const poll = setInterval(() => {
      isSettled()
        .then((settled) => settled && finish(true))
        .catch(() => undefined);
    }, pollMs);
  });
}
