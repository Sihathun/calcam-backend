export interface JobAttempt {
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
}

/** What the worker does with each job. Implemented in modules/meals/analysis.processor.ts and modules/profile. */
export interface JobProcessors {
  /** `image` is the processed photo when the upload request handed it over, so the worker need not download it. */
  analyzeMeal(mealId: string, attempt: JobAttempt, image?: Buffer): Promise<void>;
  deleteAccount(userId: string): Promise<void>;
}

/** Producer side, used by the API. */
export interface JobQueue {
  /** `image`: the processed JPEG of a fresh upload (spec 0003). Omitted for re-analysis, which reads storage. */
  enqueueMealAnalysis(mealId: string, image?: Buffer): Promise<void>;
  enqueueAccountDeletion(userId: string): Promise<void>;
  /** Throws if the queue backend is unreachable (used by /ready). */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const MEAL_QUEUE = 'meal-analysis';
export const ACCOUNT_QUEUE = 'account-deletion';
