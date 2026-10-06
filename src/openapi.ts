import type { Config } from './config/env';
import { buildOpenApi } from './lib/http/openapi';
import type { RouteDef } from './lib/http/route';
import { API_VERSION } from './version';

/** One place that decides the document metadata, shared by the running app and `npm run openapi`. */
export function buildOpenApiDocument(routes: RouteDef[], config: Pick<Config, 'appName' | 'publicBaseUrl'>) {
  return buildOpenApi(routes, {
    title: `${config.appName} API`,
    version: API_VERSION,
    description: `REST API for ${config.appName}. Metric units everywhere; timestamps are ISO-8601 UTC. Authenticate with a Bearer access token.`,
    serverUrl: config.publicBaseUrl,
  });
}
