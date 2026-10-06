import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { AppDeps } from '../deps';
import { AppError, type ErrorDetail } from '../lib/errors';
import { localizeError } from '../lib/i18n';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

/** Turns every failure into the single documented error shape. Unknown errors never leak their message. */
export function createErrorHandler(deps: Pick<AppDeps, 'logger' | 'errorReporter'>): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong';
    let details: ErrorDetail[] | undefined;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'The request body is not valid JSON';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'The request body is too large';
    } else if (err instanceof ZodError) {
      // Only reachable when a response failed its own schema, which is a server bug.
      deps.logger.error({ issues: err.issues, path: req.path }, 'response failed schema validation');
    }

    if (status >= 500) {
      deps.logger.error({ err, requestId: req.id, path: req.path }, 'unhandled error');
      deps.errorReporter.capture(err, { requestId: String(req.id), path: req.path });
    }

    const body: { error: { code: string; message: string; details?: ErrorDetail[] } } = {
      error: { code, message: localizeError(code, message, req.headers['accept-language']) },
    };
    if (details?.length) body.error.details = details;
    res.status(status).json(body);
  };
}
