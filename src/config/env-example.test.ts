import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './env';

describe('.env.example', () => {
  const values = parse(readFileSync(resolve(__dirname, '../../.env.example')));

  it('is a valid configuration as shipped', () => {
    const config = loadConfig(values);
    expect(config.appName).toBe('CalorieScan AI');
    expect(config.ai.provider).toBe('fake');
    expect(config.queue.driver).toBe('bullmq');
  });

  it('documents every variable the app reads', () => {
    const source = readFileSync(resolve(__dirname, 'env.ts'), 'utf8');
    const read = [...source.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*(?:z\.|int\(|num\(|bool\(|csv)/gm)].map((m) => m[1]!);
    const missing = read.filter((name) => !(name in values));
    expect(missing).toEqual([]);
  });
});
