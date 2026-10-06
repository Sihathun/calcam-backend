import type { Config } from '../../config/env';
import { AnthropicAnalyzer } from './anthropic';
import { FakeAnalyzer } from './fake';
import { OpenAiAnalyzer } from './openai';
import type { MealAnalyzer } from './types';

export * from './types';

export function createAnalyzer(config: Config): MealAnalyzer {
  switch (config.ai.provider) {
    case 'anthropic':
      return new AnthropicAnalyzer(config);
    case 'openai':
      return new OpenAiAnalyzer(config);
    case 'fake':
      return new FakeAnalyzer();
  }
}
