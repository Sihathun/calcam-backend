import type * as Genai from '@google/genai' with { 'resolution-mode': 'import' };
import { z } from 'zod';
import type { Config } from '../../config/env';
import { TransientError } from '../errors';
import { ProviderError, type AnalyzerInput, type AnalyzerOutput, type MealAnalyzer } from './types';
import { buildUserText, SYSTEM_PROMPT } from './prompts/meal-analysis.v2';
import { aiMealWireSchema } from './schema';

// The SDK ships a CommonJS build, but its type declarations are ESM only, so the types are imported
// in "import" mode and the runtime is loaded with require (this project compiles to CommonJS).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError, GoogleGenAI } = require('@google/genai') as typeof Genai;
type GenerateContentResponse = Genai.GenerateContentResponse;
type Part = Genai.Part;

/** The subset of the SDK the analyzer uses, so tests can stub it. */
export interface GeminiClient {
  models: { generateContent: Genai.GoogleGenAI['models']['generateContent'] };
}

/** JSON Schema for structured output. Gemini rejects the `$schema` keyword, so it is dropped. */
function responseSchema(): unknown {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(aiMealWireSchema) as Record<string, unknown>;
  return schema;
}

/** AI_EFFORT mapped onto Gemini's thinking levels (unset = the model's default). */
const THINKING_LEVEL = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'HIGH', max: 'HIGH' } as const;

const BLOCKING_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export class GeminiAnalyzer implements MealAnalyzer {
  private readonly client: GeminiClient;
  private readonly schema = responseSchema();

  /** `client` is injectable so tests can stub the HTTP layer. */
  constructor(
    private readonly config: Config,
    client?: GeminiClient,
  ) {
    // The queue owns retries (3 attempts with backoff), so the SDK's own retries are turned off.
    this.client =
      client ??
      new GoogleGenAI({
        apiKey: config.ai.geminiApiKey,
        httpOptions: { timeout: config.ai.timeoutMs, retryOptions: { attempts: 1 } },
      });
  }

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    const parts: Part[] = [];
    if (input.image) {
      parts.push({ inlineData: { mimeType: input.image.mimeType, data: input.image.data.toString('base64') } });
    }
    parts.push({ text: buildUserText(input) });

    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: this.config.ai.model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          // The same photo should get the same answer as far as the model allows.
          temperature: 0,
          responseMimeType: 'application/json',
          responseJsonSchema: this.schema,
          ...(this.config.ai.effort
            ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL[this.config.ai.effort] as Genai.ThinkingLevel } }
            : {}),
        },
      });
    } catch (err) {
      throw classify(err);
    }

    if (response.promptFeedback?.blockReason) {
      throw new ProviderError(`Gemini blocked the input: ${response.promptFeedback.blockReason}`);
    }
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && BLOCKING_FINISH.has(finish)) throw new ProviderError(`Gemini stopped: ${finish}`);

    const text = response.text ?? '';
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Left as a string. The worker's schema validation rejects it and retries once.
    }
    return { raw, provider: 'gemini', model: this.config.ai.model };
  }
}

function classify(err: unknown): Error {
  if (err instanceof ApiError) {
    const s = err.status;
    if (s === 408 || s === 409 || s === 429 || s >= 500) return new TransientError(`Gemini API ${s}`, err);
    return new ProviderError(`Gemini API ${s}: ${err.message}`, err);
  }
  // Timeouts and dropped connections surface as plain errors (no HTTP status); a retry may succeed.
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError' || err instanceof TypeError)) {
    return new TransientError('Gemini connection error', err);
  }
  return new ProviderError('Unexpected analyzer failure', err);
}
