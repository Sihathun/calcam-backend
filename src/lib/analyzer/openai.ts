import type { Config } from '../../config/env';
import { TransientError } from '../errors';
import { ProviderError, type AnalyzerInput, type AnalyzerOutput, type MealAnalyzer } from './types';
import { buildUserText, SYSTEM_PROMPT } from './prompts/meal-analysis.v3';

/** Works with OpenAI and any server that implements the same chat-completions API (set OPENAI_BASE_URL). */
export class OpenAiAnalyzer implements MealAnalyzer {
  constructor(private readonly config: Config) {}

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    const userContent: unknown[] = [{ type: 'text', text: buildUserText(input) }];
    if (input.image) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${input.image.mimeType};base64,${input.image.data.toString('base64')}` },
      });
    }

    let res: Response;
    try {
      res = await fetch(`${this.config.ai.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.ai.openaiApiKey}` },
        body: JSON.stringify({
          model: this.config.ai.model,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `${SYSTEM_PROMPT}\n\nReturn a JSON object with exactly these keys: isFood, confidence, dishes[{match, nameEn, nameKm, portion, standardServing{description, calories, proteinG, carbsG, fatG, healthScore}}].`,
            },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(this.config.ai.timeoutMs),
      });
    } catch (err) {
      throw new TransientError('OpenAI request failed', err);
    }

    if (res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500) {
      throw new TransientError(`OpenAI API ${res.status}`);
    }
    if (!res.ok) throw new ProviderError(`OpenAI API ${res.status}`);

    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content ?? '';
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Rejected by schema validation in the worker.
    }
    return { raw, provider: 'openai', model: this.config.ai.model };
  }
}
