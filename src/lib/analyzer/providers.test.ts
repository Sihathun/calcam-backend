import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/env';
import { TransientError } from '../errors';
import { AnthropicAnalyzer } from './anthropic';
import { GeminiAnalyzer, type GeminiClient } from './gemini';
import { OpenAiAnalyzer } from './openai';
import { ProviderError, type AnalyzerInput } from './types';

const config = (env: Record<string, string> = {}) =>
  loadConfig({ DATABASE_URL: 'x', JWT_ACCESS_SECRET: 'a'.repeat(32), ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-openai', ...env });

const meal = {
  isFood: true,
  confidence: 0.82,
  dishes: [
    {
      match: 'kuy-teav', nameEn: 'Pork Noodle Soup (Kuy Teav)', nameKm: 'គុយទាវ', portion: '1',
      standardServing: { description: '1 bowl', calories: 420, proteinG: 22, carbsG: 58, fatG: 11, healthScore: 6 },
    },
  ],
};
const input: AnalyzerInput = {
  dishes: [{ slug: 'kuy-teav', nameEn: 'Pork Noodle Soup (Kuy Teav)', nameKm: 'គុយទាវ', serving: '1 bowl (about 580 g)' }],
  image: { data: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' },
  hint: 'with extra mayo',
  corrections: ['it was chicken'],
  previous: { name: 'Turkey Sandwich', calories: 460, proteinG: 25, carbsG: 45, fatG: 20 },
  locale: 'en',
};

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify(meal) }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  ...over,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function anthropicWith(responder: (req: Record<string, any>) => Response | Promise<Response>, env: Record<string, string> = {}) {
  const requests: Record<string, any>[] = [];
  const fetchStub = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    return responder(body);
  }) as typeof fetch;
  const cfg = config(env);
  const client = new Anthropic({ apiKey: 'sk-test', fetch: fetchStub, maxRetries: 0 });
  return { analyzer: new AnthropicAnalyzer(cfg, client), requests };
}

describe('AnthropicAnalyzer', () => {
  it('sends the photo, the prompt and a JSON schema, and returns the parsed answer', async () => {
    const { analyzer, requests } = anthropicWith(() => json(message()));
    const out = await analyzer.analyze(input);
    expect(out).toEqual({ raw: meal, provider: 'anthropic', model: 'claude-opus-5-5' });

    const body = requests[0]!;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.system).toContain('food recognition assistant');
    const [first, second] = body.messages[0].content;
    expect(first).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') } });
    expect(second.type).toBe('text');
    expect(second.text).toContain('with extra mayo');
    expect(second.text).toContain('1. it was chicken'); // corrections are authoritative and numbered
    expect(second.text).toContain('A previous answer was');
    expect(second.text).toContain('kuy-teav | Pork Noodle Soup (Kuy Teav)'); // the dish list
    // Structured output, not forced tool use (which Opus 5.5 rejects).
    expect(body.output_config.format.type).toBe('json_schema');
    expect(Object.keys(body.output_config.format.schema.properties)).toEqual(
      expect.arrayContaining(['isFood', 'confidence', 'dishes']),
    );
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('works without an image for text descriptions', async () => {
    const { analyzer, requests } = anthropicWith(() => json(message()));
    await analyzer.analyze({ dishes: [], description: 'two eggs and toast', corrections: [], locale: 'en' });
    const content = requests[0]!.messages[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].text).toContain('two eggs and toast');
  });

  it('uses the configured model and optional effort', async () => {
    const { analyzer, requests } = anthropicWith(() => json(message()), { AI_MODEL: 'claude-sonnet-5-5', AI_EFFORT: 'low' });
    await analyzer.analyze(input);
    expect(requests[0]!.model).toBe('claude-sonnet-5-5');
    expect(requests[0]!.output_config.effort).toBe('low');
  });

  it('hands unparseable text back as-is so the worker can reject and retry it', async () => {
    const { analyzer } = anthropicWith(() => json(message({ content: [{ type: 'text', text: 'This looks like a sandwich!' }] })));
    expect((await analyzer.analyze(input)).raw).toBe('This looks like a sandwich!');
  });

  it('treats a refusal as permanent', async () => {
    const { analyzer } = anthropicWith(() => json(message({ stop_reason: 'refusal', content: [] })));
    await expect(analyzer.analyze(input)).rejects.toBeInstanceOf(ProviderError);
  });

  const err = (status: number) => json({ type: 'error', error: { type: 'api_error', message: `status ${status}` } }, status);
  it.each([429, 500, 502, 503, 529])('HTTP %i is transient (the queue retries it)', async (status) => {
    const { analyzer } = anthropicWith(() => err(status));
    await expect(analyzer.analyze(input)).rejects.toBeInstanceOf(TransientError);
  });
  it.each([400, 401, 403, 404])('HTTP %i is permanent', async (status) => {
    const { analyzer } = anthropicWith(() => err(status));
    await expect(analyzer.analyze(input)).rejects.toBeInstanceOf(ProviderError);
  });
  it('a dropped connection is transient', async () => {
    const { analyzer } = anthropicWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(analyzer.analyze(input)).rejects.toBeInstanceOf(TransientError);
  });
});

describe('OpenAiAnalyzer', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (responder: (body: Record<string, any>, url: string) => Response) => {
    const calls: { url: string; body: Record<string, any>; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, headers: init.headers as Record<string, string> });
      return responder(body, url);
    });
    return calls;
  };

  it('posts a chat completion with the image as a data URL and parses the JSON answer', async () => {
    const calls = stub(() => json({ choices: [{ message: { content: JSON.stringify(meal) } }] }));
    const out = await new OpenAiAnalyzer(config({ AI_PROVIDER: 'openai' })).analyze(input);
    expect(out).toEqual({ raw: meal, provider: 'openai', model: 'gpt-4o' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-openai');
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    const image = calls[0]!.body.messages[1].content.find((c: any) => c.type === 'image_url');
    expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('honours OPENAI_BASE_URL and classifies errors', async () => {
    stub(() => json({}, 429));
    const analyzer = new OpenAiAnalyzer(config({ AI_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:11434/v1' }));
    await expect(analyzer.analyze(input)).rejects.toBeInstanceOf(TransientError);
    stub(() => json({}, 400));
    await expect(analyzer.analyze(input)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('GeminiAnalyzer', () => {
  // The SDK's own error class, loaded the same way gemini.ts loads it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ApiError } = require('@google/genai') as { ApiError: new (o: { message: string; status: number }) => Error };
  const gemini = (env: Record<string, string> = {}) => config({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-test', ...env });

  function geminiWith(respond: (req: Record<string, any>) => unknown, env: Record<string, string> = {}) {
    const requests: Record<string, any>[] = [];
    const client = {
      models: {
        generateContent: async (req: Record<string, any>) => {
          requests.push(req);
          return respond(req);
        },
      },
    } as unknown as GeminiClient;
    return { analyzer: new GeminiAnalyzer(gemini(env), client), requests };
  }
  const answer = (text: string, over: Record<string, unknown> = {}) => ({
    text,
    candidates: [{ finishReason: 'STOP' }],
    ...over,
  });

  it('defaults to gemini-3.8-flash and needs GEMINI_API_KEY', () => {
    expect(gemini().ai.model).toBe('gemini-3.8-flash');
    expect(() => config({ AI_PROVIDER: 'gemini' })).toThrow(/GEMINI_API_KEY/);
  });

  it('sends the photo inline with the prompt, temperature 0 and a JSON schema, and returns the parsed answer', async () => {
    const { analyzer, requests } = geminiWith(() => answer(JSON.stringify(meal)));
    const out = await analyzer.analyze(input);
    expect(out).toEqual({ raw: meal, provider: 'gemini', model: 'gemini-3.8-flash' });

    const req = requests[0]!;
    expect(req.model).toBe('gemini-3.8-flash');
    const [image, text] = req.contents[0].parts;
    expect(image).toEqual({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') } });
    expect(text.text).toContain('1. it was chicken');
    expect(req.config).toMatchObject({ temperature: 0, responseMimeType: 'application/json' });
    expect(req.config.systemInstruction).toContain('food recognition assistant');
    expect(req.config.responseJsonSchema).toMatchObject({ type: 'object' });
    expect(req.config.responseJsonSchema.$schema).toBeUndefined();
    expect(req.config.thinkingConfig).toBeUndefined();
  });

  it('maps AI_EFFORT onto a thinking level', async () => {
    const { analyzer, requests } = geminiWith(() => answer(JSON.stringify(meal)), { AI_EFFORT: 'low' });
    await analyzer.analyze(input);
    expect(requests[0]!.config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  it('hands unparseable text back as-is so the worker can reject and retry it', async () => {
    const { analyzer } = geminiWith(() => answer('not json'));
    expect((await analyzer.analyze(input)).raw).toBe('not json');
  });

  it('classifies errors: 429 and 5xx retry, 4xx and safety blocks do not', async () => {
    const failWith = (status: number) =>
      geminiWith(() => {
        throw new ApiError({ message: 'boom', status });
      }).analyzer;
    await expect(failWith(429).analyze(input)).rejects.toBeInstanceOf(TransientError);
    await expect(failWith(503).analyze(input)).rejects.toBeInstanceOf(TransientError);
    await expect(failWith(400).analyze(input)).rejects.toBeInstanceOf(ProviderError);

    const blocked = geminiWith(() => answer('', { candidates: [{ finishReason: 'SAFETY' }] })).analyzer;
    await expect(blocked.analyze(input)).rejects.toBeInstanceOf(ProviderError);
    const refused = geminiWith(() => answer('', { promptFeedback: { blockReason: 'OTHER' } })).analyzer;
    await expect(refused.analyze(input)).rejects.toBeInstanceOf(ProviderError);

    const dropped = geminiWith(() => {
      throw new TypeError('fetch failed');
    }).analyzer;
    await expect(dropped.analyze(input)).rejects.toBeInstanceOf(TransientError);
  });
});
