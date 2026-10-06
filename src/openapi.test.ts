import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate } from '../scripts/export-openapi';

describe('openapi/openapi.json', () => {
  const { document, routes } = generate();

  it('is committed and up to date. Run `npm run openapi` after changing a route or schema.', () => {
    const committed = JSON.parse(readFileSync(resolve(__dirname, '../openapi/openapi.json'), 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(document)));
  });

  it('documents every registered route exactly once', () => {
    const operations = Object.values<any>(document['paths']).flatMap((p) => Object.keys(p));
    expect(operations).toHaveLength(routes.length);
  });

  it('gives every operation a summary, a tag and at least one success response', () => {
    for (const [path, ops] of Object.entries<any>(document['paths'])) {
      for (const [method, op] of Object.entries<any>(ops)) {
        const label = `${method.toUpperCase()} ${path}`;
        expect(op.summary, label).toBeTruthy();
        expect(op.tags?.length, label).toBeGreaterThan(0);
        expect(Object.keys(op.responses).some((s) => s.startsWith('2')), label).toBe(true);
      }
    }
  });
});
