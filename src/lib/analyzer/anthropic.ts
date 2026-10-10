import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Config } from '../../config/env';
import { TransientError } from '../errors';
import { ProviderError, type AnalyzerInput, type AnalyzerOutput, type MealAnalyzer } from './types';
import { buildUserText, SYSTEM_PROMPT } from './prompts/meal-analysis.v2';
import { aiMealWireSchema } from './schema';

export class AnthropicAnalyzer implements MealAnalyzer {
  private readonly client: Anthropic;

  /** `client` is injectable so tests can stub the HTTP layer. */
  constructor(
    private readonly config: Config,
    client?: Anthropic,
  ) {
    // The queue owns retries (3 attempts with backoff), so the SDK's own retries are turned off.
    this.client = client ?? new Anthropic({ apiKey: config.ai.anthropicApiKey, maxRetries: 0, timeout: config.ai.timeoutMs });
  }

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    const content: Anthropic.ContentBlockParam[] = [];
    if (input.image) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: input.image.mimeType, data: input.image.data.toString('base64') },
      });
    }
    content.push({ type: 'text', text: buildUserText(input) });

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.config.ai.model,
        // Thinking tokens count against max_tokens, so leave generous room for the small JSON answer.
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        output_config: {
          format: zodOutputFormat(aiMealWireSchema),
          ...(this.config.ai.effort ? { effort: this.config.ai.effort } : {}),
        },
      });
    } catch (err) {
      throw classify(err);
    }

    if (response.stop_reason === 'refusal') throw new ProviderError('The model declined to analyze this input');
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Left as a string. The worker's schema validation rejects it and retries once.
    }
    return { raw, provider: 'anthropic', model: this.config.ai.model };
  }
}

function classify(err: unknown): Error {
  if (err instanceof Anthropic.APIConnectionError) return new TransientError('Anthropic connection error', err);
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    if (s === 408 || s === 409 || s === 429 || (s !== undefined && s >= 500)) {
      return new TransientError(`Anthropic API ${s}`, err);
    }
    return new ProviderError(`Anthropic API ${s}: ${err.message}`, err);
  }
  return new ProviderError('Unexpected analyzer failure', err);
}
