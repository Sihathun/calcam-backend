import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config/env';
import type { AppDeps } from '../src/deps';
import { buildRoutes } from '../src/modules';
import { buildOpenApiDocument } from '../src/openapi';

/** Writes openapi/openapi.json from the route registry. No database or network is needed. */
export function generate() {
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused', JWT_ACCESS_SECRET: 'x'.repeat(32), PUBLIC_BASE_URL: 'http://localhost:3000' });
  // Services only read their dependencies inside handlers, so a bare config is enough to list the routes.
  const routes = buildRoutes({ config } as AppDeps, () => undefined);
  return { routes, document: buildOpenApiDocument(routes, config) };
}

if (require.main === module) {
  const out = resolve(__dirname, '../openapi/openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(generate().document, null, 2) + '\n');
  console.log(`wrote ${out}`);
}
