import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { AppDeps } from './deps';
import { mountRoutes, type AuthUser } from './lib/http/route';
import { createMetrics } from './lib/metrics';
import { FsStorage } from './lib/storage/fs';
import { createAuthenticate } from './middleware/authenticate';
import { createErrorHandler, notFoundHandler } from './middleware/error-handler';
import { createLimiters } from './middleware/rate-limit';
import { createUpload } from './middleware/upload';
import { buildRoutes } from './modules';
import { buildOpenApiDocument } from './openapi';

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 100 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customProps: (req) => ({ userId: (req as { user?: AuthUser }).user?.id }),
      // Bodies, headers and query strings are never logged.
      serializers: {
        req: (r) => ({ id: r.id, method: r.method, url: String(r.url).split('?')[0] }),
        res: (r) => ({ statusCode: r.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(
    helmet({
      // Swagger UI is served over plain http in development.
      contentSecurityPolicy: config.isProd ? undefined : { directives: { 'upgrade-insecure-requests': null } },
    }),
  );
  // Mobile clients send no Origin header, so CORS only matters for web tooling. Empty allowlist = no cross-origin access.
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));

  const metrics = config.metricsEnabled ? createMetrics() : undefined;
  if (metrics) app.use(metrics.middleware);
  app.use(express.json({ limit: '100kb' }));

  const { limiters, userLimiter } = createLimiters(deps);
  const mountOptions = {
    authenticate: createAuthenticate(deps),
    userLimiter,
    limiters,
    upload: createUpload(config),
  };

  // The route list needs the OpenAPI document (for /openapi.json) and the document needs the route list.
  let openApi: unknown;
  const routes = buildRoutes(deps, () => openApi, metrics);
  openApi = buildOpenApiDocument(routes, config);

  const rootRouter = Router();
  mountRoutes(rootRouter, routes.filter((r) => r.root), mountOptions);
  app.use(rootRouter);

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApi as swaggerUi.JsonObject, { customSiteTitle: `${config.appName} API` }));

  // Development only: serves images that the filesystem driver signed, standing in for S3 presigned URLs.
  if (deps.storage instanceof FsStorage) {
    const fsStorage = deps.storage;
    app.get('/dev-storage/*key', async (req, res) => {
      const key = ([] as string[]).concat(req.params['key'] ?? []).join('/');
      if (!fsStorage.verify(key, Number(req.query['expires']), String(req.query['sig'] ?? ''))) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid or expired link' } });
        return;
      }
      try {
        // The signature is the access check, so the image may be shown by the web app on another origin
        // (helmet's default same-origin policy would block it, unlike a real storage provider's links).
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.type('image/jpeg').send(await fsStorage.get(key));
      } catch {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      }
    });
  }

  const apiRouter = Router();
  mountRoutes(apiRouter, routes.filter((r) => !r.root), mountOptions);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps));
  return app;
}
