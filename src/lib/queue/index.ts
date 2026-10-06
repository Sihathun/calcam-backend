export interface JobAttempt {
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
}

/** What the worker does with each job. Implemented in modules/meals/analysis.processor.ts and modules/profile. */
export interface JobProcessors {
  analyzeMeal(mealId: string, attempt: JobAttempt): Promise<void>;
  deleteAccount(userId: string): Promise<void>;
}

/** Producer side, used by the API. */
export interface JobQueue {
  enqueueMealAnalysis(mealId: string): Promise<void>;
  enqueueAccountDeletion(userId: string): Promise<void>;
  /** Throws if the queue backend is unreachable (used by /ready). */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const MEAL_QUEUE = 'meal-analysis';
export const ACCOUNT_QUEUE = 'account-deletion';
