export interface AnalyzerInput {
  /** Always a JPEG produced by lib/image.ts. */
  image?: { data: Buffer; mimeType: 'image/jpeg' };
  /** Text-only analysis ("2 eggs and toast"). */
  description?: string;
  /** Free-text note sent with the upload. */
  hint?: string;
  /** "Fix Results" instructions, oldest first. */
  corrections: string[];
  previous?: {
    name: string | null;
    calories: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
  };
  locale: string;
}

export interface AnalyzerOutput {
  /** Parsed JSON from the provider. Unvalidated: the worker checks it against aiMealSchema. */
  raw: unknown;
  provider: string;
  model: string;
}

/** Providers are swappable via AI_PROVIDER. Only the worker process ever calls an implementation. */
export interface MealAnalyzer {
  analyze(input: AnalyzerInput): Promise<AnalyzerOutput>;
}

/** A failure that retrying will not fix (bad request, refusal, bad credentials). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
